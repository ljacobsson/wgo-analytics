import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;

import 'config.dart';
import 'event.dart';
import 'platform/gzip_stub.dart' if (dart.library.io) 'platform/gzip_io.dart';
import 'session.dart';
import 'storage.dart';
import 'transport.dart';
import 'util.dart';

const sdkName = 'wgo-flutter/0.1.0';

const _stackMax = 4000;
const _coalesceMs = 5000;
const _errorsPerMinute = 30;

/// The first Dart stack frame with a location: `#0  Foo.bar (package:app/foo.dart:12:7)`.
final _frame = RegExp(r'^#\d+\s+.*\((.+?):(\d+)(?::(\d+))?\)\s*$', multiLine: true);

/// The SDK's state for one write key. Apps normally use the `Wgo` facade, which creates one of these in `Wgo.init`.
class WgoClient {
  WgoClient({
    required WgoConfig config,
    WgoStorage? storage,
    http.Client? httpClient,
    Map<String, Object?> context = const {},
    void Function(String line)? printer,
  })  : cfg = config,
        _endpoint = config.endpoint.replaceFirst(RegExp(r'/+$'), ''),
        _print = printer {
    final store = config.memoryOnly ? MemoryStorage() : (storage ?? MemoryStorage());
    session = Session(config.sessionTimeout, config.sampleRate, store);
    ctx = {...context, 'sdk': sdkName};
    if (config.release != null) ctx['release'] = config.release;
    if (config.environment != null) ctx['env'] = config.environment;
    _transport = Transport(
      url: Uri.parse('$_endpoint/ingest'),
      cfg: config,
      client: httpClient ?? http.Client(),
      store: store,
      storageKey: 'wgo:q:${config.writeKey}',
      meta: () => {'k': config.writeKey, 'ctx': ctx},
      log: log,
      gzip: platformGzip,
    );
    _transport.restore();
  }

  final WgoConfig cfg;
  final String _endpoint;
  final void Function(String line)? _print;
  late final Session session;
  late final Transport _transport;

  /// Merged into every batch (`ctx`): device and app details, plus whatever `setContext` adds.
  late final Map<String, Object?> ctx;

  bool _stopped = false;
  String _path = '/';
  String _url = 'app:/';
  String? _title;
  bool _hasScreen = false;

  // error coalescing and rate limit
  ({String key, WgoEvent ev, int at})? _lastError;
  final List<int> _errorStamps = [];

  // rage taps: the same target three or more times within a second
  String? _streakSel;
  List<int> _streakTimes = [];
  WgoEvent? _streakEv;

  /// Events waiting to be sent.
  int get queued => _transport.length;
  bool get stopped => _stopped;
  String get endpoint => _endpoint;

  /// The current screen's route name.
  String get currentPath => _path;

  void log(String msg, [Object? detail]) {
    if (!cfg.debug) return;
    final line = '[wgo] $msg${detail != null ? ' $detail' : ''}';
    final p = _print;
    if (p != null) {
      p(line);
    } else {
      // ignore: avoid_print
      print(line);
    }
  }

  /// Queues an event of [type] on the current screen. Returns it, or null when it was dropped (stopped, sampled out,
  /// `beforeSend`).
  WgoEvent? emit(String type, [Map<String, Object?>? data, bool priority = false, String? ref]) {
    try {
      if (_stopped) return null;
      final s = session.touch();
      if (!s.sampled) return null;
      var e = WgoEvent(
        id: uuid(),
        type: type,
        ts: nowMs(),
        session: s.id,
        user: session.uid,
        url: _url,
        path: _path,
        title: _title,
        ref: ref,
        data: data,
      );
      final bs = cfg.beforeSend;
      if (bs != null) {
        WgoEvent? r = e;
        try {
          r = bs(e);
        } catch (_) {/* a throwing hook must not lose the event */}
        if (r == null) return null;
        e = r;
      }
      _transport.push(e, session.aid,
          priority: priority || type == WgoEventType.error || type == WgoEventType.httpError);
      return e;
    } catch (err) {
      log('emit failed', err);
      return null;
    }
  }

  String clean(String url) => cfg.captureQueryParams ? url : url.replaceFirst(RegExp(r'\?[^#]*'), '');

  /// A screen view (a `pageview` event). [name] is the route name, e.g. `/settings`; its query string is kept only
  /// with `captureQueryParams`.
  void screen(String name, {String? title, Map<String, Object?>? properties}) {
    if (_stopped) return;
    var n = name.trim();
    if (n.isEmpty) n = '/';
    if (!n.startsWith('/')) n = '/$n';
    final cut = n.indexOf(RegExp(r'[?#]'));
    final prev = _hasScreen ? _url : null;
    _path = cut < 0 ? n : n.substring(0, cut);
    _url = clean('app:$n');
    _title = title;
    _hasScreen = true;
    emit(WgoEventType.pageview, properties, false, prev);
  }

  void track(String name, [Map<String, Object?>? properties]) =>
      emit(WgoEventType.custom, {'name': name, if (properties != null) 'props': properties});

  /// Attaches [userId] (`u`) to this and every later event, until [reset].
  void identify(String userId, [Map<String, Object?>? traits]) {
    if (_stopped) return;
    session.identify(userId);
    emit(WgoEventType.identify, {if (traits != null) 'traits': traits});
  }

  /// Logout: forget the user and continue as a new anonymous visitor with a new session. Queued events keep the
  /// visitor they were recorded for.
  void reset() {
    session.reset();
    _transport.flush();
  }

  /// Merged into every batch's `ctx`.
  void setContext(Map<String, Object?> values) {
    ctx.addAll(values);
    ctx['sdk'] = sdkName;
  }

  /// Reports a caught error (kind `manual`). Without [stack], an [Error]'s own stack trace is used. [extra] is
  /// stored with it.
  void captureException(Object error, [StackTrace? stack, Map<String, Object?>? extra]) => reportError(error.toString(),
      stack: (stack ?? (error is Error ? error.stackTrace : null))?.toString(), kind: 'manual', extra: extra);

  /// Reports an error. Identical errors within 5 seconds are counted on one event; at most 30 per minute.
  void reportError(String message, {String? stack, String kind = 'error', Map<String, Object?>? extra}) {
    try {
      if (_stopped) return;
      final now = nowMs();
      final d = <String, Object?>{'msg': truncate(message.isEmpty ? 'Unknown error' : message, 1000), 'kind': kind};
      if (stack != null && stack.trim().isNotEmpty) {
        d['stack'] = truncate(stack, _stackMax);
        final m = _frame.firstMatch(stack);
        if (m != null) {
          d['src'] = m.group(1);
          d['line'] = int.parse(m.group(2)!);
          if (m.group(3) != null) d['col'] = int.parse(m.group(3)!);
        }
      }
      if (extra != null) d['extra'] = extra;
      final key = '${d['msg']}|${d['src'] ?? ''}|${d['line'] ?? ''}';
      final l = _lastError;
      if (l != null && l.key == key && now - l.at < _coalesceMs && _transport.has(l.ev) && l.ev.data != null) {
        final ld = l.ev.data!;
        ld['count'] = ((ld['count'] as int?) ?? 1) + 1;
        _lastError = (key: key, ev: l.ev, at: now);
        return;
      }
      _errorStamps.removeWhere((t) => now - t >= 60000);
      if (_errorStamps.length >= _errorsPerMinute) return;
      _errorStamps.add(now);
      final ev = emit(WgoEventType.error, d, true);
      if (ev != null) _lastError = (key: key, ev: ev, at: now);
    } catch (err) {
      log('error report failed', err);
    }
  }

  /// A tap (a `click` event) on the control [sel] identifies. [name] is a `WgoTrack` name, [label] the control's
  /// visible text, [tag] its widget type. [x]/[y] are logical pixels in the view, [width]/[height] the view's size.
  void tap(String sel,
      {String? name,
      String? label,
      String tag = 'widget',
      double x = 0,
      double y = 0,
      double width = 0,
      double height = 0,
      bool priority = false}) {
    if (_stopped) return;
    final now = nowMs();
    if (_streakSel == sel) {
      _streakTimes = [..._streakTimes.where((t) => now - t <= 1000), now];
    } else {
      _streakSel = sel;
      _streakTimes = [now];
      _streakEv = null;
    }
    final rage = _streakTimes.length;
    if (rage < 3) {
      _streakEv = null;
    } else if (_streakEv != null) {
      // already reported this rage burst: only bump the count while it's still queued
      final ev = _streakEv!;
      if (_transport.has(ev)) ev.data?['rage'] = rage;
      return;
    }
    final d = <String, Object?>{
      'sel': truncate(sel, 200),
      'tag': tag,
      if (name != null) 'name': name,
      if (label != null && label.isNotEmpty) 'text': truncate(label, 80),
      'x': x.round(),
      'y': y.round(),
      'vw': width.round(),
      'vh': height.round(),
      if (rage >= 3) 'rage': rage,
    };
    final ev = emit(WgoEventType.click, d, priority);
    if (rage >= 3) _streakEv = ev;
  }

  /// False for the SDK's own requests and URLs matching `httpIgnore`: those are never reported.
  bool reportsUrl(String url) => !url.startsWith('$_endpoint/') && !matchesAny(cfg.httpIgnore, url);

  /// The W3C `traceparent` header value for a request to [url], or null (turned off, or not in `traceOrigins`).
  String? traceparent(String url) {
    if (!cfg.tracePropagation || url.startsWith('$_endpoint/')) return null;
    if (cfg.traceOrigins.isNotEmpty) {
      if (!matchesAny(cfg.traceOrigins, url)) return null;
    } else if (kIsWeb && !_sameOrigin(url)) {
      return null; // a custom header makes cross-origin requests preflight, which the API may not allow
    }
    // random v4 uuids: never all zeros, as W3C requires
    final trace = uuid().replaceAll('-', '');
    final span = uuid().replaceAll('-', '').substring(16);
    return '00-$trace-$span-01';
  }

  static bool _sameOrigin(String url) {
    try {
      return Uri.base.resolve(url).origin == Uri.base.origin;
    } catch (_) {
      return false;
    }
  }

  /// Reports a failed request (an `http_error` event). [status] 0 means no response (network failure, timeout).
  /// [traceparent] is the header the request was sent with, linking it to the backend trace.
  void captureHttpError({
    required String method,
    required String url,
    required int status,
    String? statusText,
    Duration? duration,
    String? traceparent,
  }) {
    if (_stopped || !reportsUrl(url)) return;
    final parts = traceparent?.split('-');
    emit(WgoEventType.httpError, {
      'method': method.toUpperCase(),
      'url': clean(url),
      'status': status,
      if (statusText != null && statusText.isNotEmpty) 'statusText': statusText,
      'dur': duration?.inMilliseconds ?? 0,
      'kind': 'dart',
      if (parts != null && parts.length == 4) ...{'trace': parts[1], 'span': parts[2]},
    });
  }

  /// The app went to the background: save the session and start sending, keeping the queue on the device.
  void paused() {
    if (_stopped) return;
    session.save();
    _transport.pause();
  }

  /// The app came back. After the session timed out, the current screen is viewed again in the new session.
  void resumed() {
    if (_stopped) return;
    if (_hasScreen && session.expired) emit(WgoEventType.pageview);
    _transport.resume();
  }

  /// Sends everything queued.
  Future<void> flush() => _transport.flush();

  /// Sends what's queued (waiting at most [timeout]), then stops. Unsent events stay on the device.
  Future<void> shutdown({Duration timeout = const Duration(seconds: 2)}) async {
    if (_stopped) return;
    try {
      await _transport.flush().timeout(timeout);
    } catch (_) {/* sent next time */}
    _stopped = true;
    _transport.close();
  }

  /// A stopwatch on the SDK's clock (fakeable in tests).
  static Stopwatch stopwatch() => clock.stopwatch()..start();
}
