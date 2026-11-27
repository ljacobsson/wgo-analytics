import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

import 'client.dart';
import 'config.dart';
import 'device.dart';
import 'storage.dart';
import 'taps.dart';

/// Calls made before `init` finished, replayed once it has (bounded, so a missing `init` costs nothing).
const _maxPending = 100;

/// The SDK's entry point.
///
/// ```dart
/// void main() async {
///   WidgetsFlutterBinding.ensureInitialized();
///   await Wgo.init(const WgoConfig(writeKey: 'wk_…', endpoint: 'https://wgo.example.com'));
///   runApp(MaterialApp(navigatorObservers: [WgoNavigatorObserver()], home: …));
/// }
/// ```
///
/// Every method is safe to call before `init` (calls are replayed once it completes) and never throws.
abstract final class Wgo {
  static WgoClient? _client;
  static bool _starting = false;
  static final List<void Function(WgoClient)> _pending = [];
  static _Lifecycle? _lifecycle;
  static TapCapture? _taps;
  static FlutterExceptionHandler? _prevFlutterError;
  static FlutterExceptionHandler? _ourFlutterError;
  static bool Function(Object, StackTrace)? _prevPlatformError;
  static bool Function(Object, StackTrace)? _ourPlatformError;

  /// The running client, or null before `init` and after `shutdown`.
  static WgoClient? get client => _client;

  /// Taps on every tappable widget are being reported (`captureTaps`).
  static bool get capturingTaps => _taps != null;

  /// Starts the SDK. Calling it again while it runs is ignored.
  ///
  /// [storage] and [httpClient] replace the defaults (`shared_preferences`, a plain `http.Client`), mainly for tests.
  static Future<void> init(WgoConfig config, {WgoStorage? storage, http.Client? httpClient}) async {
    if (_client != null || _starting) {
      if (config.debug) debugPrint('[wgo] init called twice; ignored');
      return;
    }
    _starting = true;
    try {
      WidgetsFlutterBinding.ensureInitialized();
      final store = config.memoryOnly ? MemoryStorage() : (storage ?? await SharedPreferencesStorage.open());
      final c = WgoClient(
        config: config,
        storage: store,
        httpClient: httpClient,
        context: deviceContext(),
        printer: debugPrint,
      );
      _client = c;
      if (config.captureErrors) _hookErrors(c);
      if (config.captureTaps) _taps = TapCapture(c)..start();
      _lifecycle = _Lifecycle(c);
      WidgetsBinding.instance.addObserver(_lifecycle!);
      final pending = List.of(_pending);
      _pending.clear();
      for (final fn in pending) {
        _guard(() => fn(c));
      }
      c.log('initialised', c.endpoint);
    } catch (err) {
      if (config.debug) debugPrint('[wgo] init failed: $err');
    } finally {
      _starting = false;
    }
  }

  static void _guard(void Function() fn) {
    try {
      fn();
    } catch (_) {/* never throw into the app */}
  }

  static void _run(void Function(WgoClient c) fn) {
    final c = _client;
    if (c != null) return _guard(() => fn(c));
    if (_pending.length < _maxPending) _pending.add(fn);
  }

  static void _hookErrors(WgoClient c) {
    _prevFlutterError = FlutterError.onError;
    _ourFlutterError = (FlutterErrorDetails details) {
      _guard(() => c.reportError(details.exceptionAsString(), stack: details.stack?.toString()));
      final prev = _prevFlutterError;
      if (prev != null) {
        prev(details);
      } else {
        FlutterError.presentError(details);
      }
    };
    FlutterError.onError = _ourFlutterError;

    final dispatcher = PlatformDispatcher.instance;
    _prevPlatformError = dispatcher.onError;
    _ourPlatformError = (Object error, StackTrace stack) {
      _guard(() => c.reportError(error.toString(), stack: stack.toString()));
      // false: not handled here, the engine logs it as it would without us
      return _prevPlatformError?.call(error, stack) ?? false;
    };
    dispatcher.onError = _ourPlatformError;
  }

  static void _unhookErrors() {
    // only when nobody replaced our handlers since; theirs may be chaining to ours
    if (_ourFlutterError != null && FlutterError.onError == _ourFlutterError) FlutterError.onError = _prevFlutterError;
    final dispatcher = PlatformDispatcher.instance;
    if (_ourPlatformError != null && dispatcher.onError == _ourPlatformError) dispatcher.onError = _prevPlatformError;
    _ourFlutterError = _prevFlutterError = null;
    _ourPlatformError = _prevPlatformError = null;
  }

  /// A custom event.
  static void track(String name, [Map<String, Object?>? properties]) => _run((c) => c.track(name, properties));

  /// A screen view. `WgoNavigatorObserver` calls this for named routes; call it yourself for screens that aren't
  /// routes (tabs, for example).
  static void screen(String name, {String? title, Map<String, Object?>? properties}) =>
      _run((c) => c.screen(name, title: title, properties: properties));

  /// Attaches [userId] to this and every later event, remembered on the device until [reset].
  static void identify(String userId, [Map<String, Object?>? traits]) => _run((c) => c.identify(userId, traits));

  /// Logout: forget the user, continue as a new anonymous visitor with a new session.
  static void reset() => _run((c) => c.reset());

  /// Reports a caught error.
  static void captureException(Object error, [StackTrace? stack, Map<String, Object?>? extra]) =>
      _run((c) => c.captureException(error, stack, extra));

  /// Reports a failed request made without `WgoHttpClient` (with Dio, for example). [status] 0 means no response.
  static void captureHttpError({
    required String method,
    required String url,
    required int status,
    String? statusText,
    Duration? duration,
    String? traceparent,
  }) =>
      _run((c) => c.captureHttpError(
          method: method, url: url, status: status, statusText: statusText, duration: duration, traceparent: traceparent));

  /// A `traceparent` header value for a request to [url], or null. Send it with the request and pass it to
  /// [captureHttpError] when it fails.
  static String? traceparent(String url) => _client?.traceparent(url);

  /// Merged into every batch's `ctx`.
  static void setContext(Map<String, Object?> values) => _run((c) => c.setContext(values));

  /// Sends everything queued now.
  static Future<void> flush() => _client?.flush() ?? Future.value();

  /// `initialized`, `endpoint` and `queued` (events waiting to be sent), for troubleshooting.
  static Map<String, Object?> status() =>
      {'initialized': _client != null, 'endpoint': _client?.endpoint, 'queued': _client?.queued ?? 0};

  /// Sends what's queued, removes the error handlers and lifecycle listener, and stops. `init` may be called again.
  static Future<void> shutdown() async {
    final c = _client;
    _client = null;
    _pending.clear();
    _unhookErrors();
    _taps?.stop();
    _taps = null;
    final l = _lifecycle;
    _lifecycle = null;
    if (l != null) WidgetsBinding.instance.removeObserver(l);
    await c?.shutdown();
  }
}

class _Lifecycle with WidgetsBindingObserver {
  _Lifecycle(this.c);
  final WgoClient c;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    try {
      switch (state) {
        case AppLifecycleState.resumed:
          c.resumed();
        case AppLifecycleState.paused || AppLifecycleState.hidden || AppLifecycleState.detached:
          c.paused();
        case AppLifecycleState.inactive:
          break;
      }
    } catch (_) {/* never throw into the app */}
  }
}
