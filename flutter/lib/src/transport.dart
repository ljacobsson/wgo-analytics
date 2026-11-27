import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'config.dart';
import 'event.dart';
import 'storage.dart';
import 'util.dart';

class _Item {
  _Item(this.e, this.aid, this.n);
  final WgoEvent e;

  /// The anonymous id the event was recorded under: a batch carries one (`a`), so `reset` mustn't relabel queued events.
  final String aid;
  final int n;
}

enum _Result { ok, retry, drop }

const _text = 'text/plain;charset=UTF-8';
const _requestTimeout = Duration(seconds: 30);

/// Batches events and POSTs them to `/ingest`: one request in flight, max-latency deadlines, retries with backoff,
/// and a copy of the queue on the device. Mirrors the web SDK's transport (sdk/src/transport.ts).
class Transport {
  Transport({
    required this.url,
    required this.cfg,
    required this.client,
    required this.store,
    required this.storageKey,
    required this.meta,
    required this.log,
    this.gzip,
  });

  final Uri url;
  final WgoConfig cfg;
  final http.Client client;
  final WgoStorage store;
  final String storageKey;

  /// Batch fields besides `a`, `sentAt` and `e`: the write key and context, read at send time.
  final Map<String, Object?> Function() meta;
  final void Function(String msg, [Object? detail]) log;
  final List<int> Function(List<int>)? gzip;

  bool get _persist => cfg.persist && !cfg.memoryOnly;

  final List<_Item> _q = [];
  List<_Item> _inflight = [];
  int _bytes = 0;
  Timer? _timer;
  int _deadline = 0;
  Timer? _retryTimer;
  Timer? _persistTimer;
  int _blockedUntil = 0;
  int _attempt = 0;
  bool _busy = false;
  bool _closed = false;
  Future<void> _running = Future.value();

  int get length => _q.length;
  bool has(WgoEvent e) => _q.any((i) => identical(i.e, e));

  void push(WgoEvent e, String aid, {bool priority = false}) {
    if (_closed) return;
    final int n;
    try {
      n = byteLen(encodeJson(e.toJson())) + 1;
    } catch (err) {
      log('event not serializable, dropped', err);
      return;
    }
    if (n >= cfg.maxBatchBytes) {
      log('event too large, dropped', e.type);
      return;
    }
    _q.add(_Item(e, aid, n));
    _bytes += n;
    _trim();
    _persistSoon();
    if (_q.length >= cfg.maxBatchSize || _bytes >= cfg.maxBatchBytes * 0.8) {
      _schedule(Duration.zero);
    } else {
      _schedule(priority ? cfg.priorityFlushDelay : cfg.flushInterval);
    }
  }

  /// Loads events left over from an earlier run (closed while offline, or killed before sending) and sends them.
  void restore() {
    if (!_persist) return;
    final raw = store.get(storageKey);
    if (raw == null) return;
    store.remove(storageKey); // we own them now; _persistSoon() rewrites them while they stay queued
    try {
      final arr = jsonDecode(raw);
      if (arr is! List) return;
      final old = <_Item>[];
      for (final x in arr) {
        if (x is! Map || x['a'] is! String) continue;
        final e = WgoEvent.fromJson(x['e']);
        if (e != null) old.add(_Item(e, x['a'] as String, byteLen(encodeJson(e.toJson())) + 1));
      }
      _q.insertAll(0, old);
      _bytes += old.fold(0, (a, i) => a + i.n);
      _trim();
      if (_q.isNotEmpty) {
        _persistSoon();
        _schedule(Duration.zero);
      }
    } catch (_) {/* corrupt, ignore */}
  }

  /// Max-latency deadline: an earlier deadline is never pushed later.
  void _schedule(Duration delay) {
    final at = nowMs() + delay.inMilliseconds;
    if (_timer != null && _deadline <= at) return;
    _timer?.cancel();
    _deadline = at;
    _timer = Timer(delay, () {
      _timer = null;
      _deadline = 0;
      flush();
    });
  }

  /// Sends everything queued. Completes when the queue is empty, or sending has to wait (backoff).
  Future<void> flush() {
    if (_busy) return _running;
    _busy = true;
    return _running = _drain();
  }

  /// The app came back to the foreground: skip any pending backoff and send.
  void resume() {
    _retryTimer?.cancel();
    _retryTimer = null;
    _blockedUntil = 0;
    flush();
  }

  /// The app is going to the background and may be suspended or killed: write the queue now and start sending.
  void pause() {
    persistNow();
    flush();
  }

  Future<void> _drain() async {
    try {
      while (_q.isNotEmpty && !_closed && nowMs() >= _blockedUntil) {
        final items = _take();
        _inflight = items;
        final r = await _send(items);
        _inflight = [];
        if (r != _Result.retry) {
          _attempt = 0;
          _persistSoon();
          continue;
        }
        if (_closed) {
          _requeue(items);
          persistNow();
          break;
        }
        if (++_attempt > cfg.maxRetries) {
          log('giving up on batch after ${cfg.maxRetries} retries');
          _attempt = 0;
          _persistSoon();
          continue;
        }
        _requeue(items);
        final delay = min(60000, 1000 * pow(2, _attempt - 1) * (1 + random.nextDouble() * 0.2)).round();
        _blockedUntil = nowMs() + delay;
        _retryTimer = Timer(Duration(milliseconds: delay), () {
          _retryTimer = null;
          _blockedUntil = 0;
          flush();
        });
        break;
      }
    } finally {
      _busy = false;
    }
  }

  /// The next batch: up to [WgoConfig.maxBatchSize] events and [WgoConfig.maxBatchBytes], all of one anonymous id.
  List<_Item> _take() {
    var size = byteLen(encodeJson({...meta(), 'a': _q.first.aid, 'sentAt': nowMs(), 'e': const []}));
    final out = <_Item>[];
    while (_q.isNotEmpty && out.length < cfg.maxBatchSize) {
      final it = _q.first;
      if (out.isNotEmpty && (size + it.n > cfg.maxBatchBytes || it.aid != out.first.aid)) break;
      _q.removeAt(0);
      _bytes -= it.n;
      size += it.n;
      out.add(it);
    }
    return out;
  }

  void _requeue(List<_Item> items) {
    _q.insertAll(0, items);
    _bytes += items.fold(0, (a, i) => a + i.n);
    _trim();
    _persistSoon();
  }

  void _trim() {
    while (_q.length > cfg.maxQueueSize) {
      _bytes -= _q.removeAt(0).n;
    }
  }

  Future<_Result> _send(List<_Item> items) async {
    List<int> data;
    var type = _text;
    try {
      final body = encodeJson({
        ...meta(),
        'a': items.first.aid,
        'sentAt': nowMs(),
        'e': [for (final i in items) i.e.toJson()],
      });
      data = utf8.encode(body);
    } catch (err) {
      log('batch not serializable, dropped', err);
      return _Result.drop;
    }
    final gz = gzip;
    if (cfg.compress && gz != null && data.length > 1024) {
      try {
        data = gz(data);
        type = 'application/octet-stream'; // the backend detects gzip by its magic bytes
      } catch (_) {/* send raw */}
    }
    try {
      final res = await client.post(url, headers: {'content-type': type}, body: data).timeout(_requestTimeout);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        log('sent ${items.length} events');
        return _Result.ok;
      }
      if (res.statusCode == 429 || res.statusCode >= 500) return _Result.retry;
      log('batch rejected with ${res.statusCode}, dropped');
      return _Result.drop;
    } catch (err) {
      log('send failed', err);
      return _Result.retry;
    }
  }

  void _persistSoon() {
    if (!_persist || _persistTimer != null) return;
    if (_closed) return persistNow();
    _persistTimer = Timer(const Duration(seconds: 1), () {
      _persistTimer = null;
      persistNow();
    });
  }

  void persistNow() {
    if (!_persist) return;
    _persistTimer?.cancel();
    _persistTimer = null;
    final all = [..._inflight, ..._q];
    final keep = all.length > cfg.maxQueueSize ? all.sublist(all.length - cfg.maxQueueSize) : all;
    if (keep.isEmpty) return store.remove(storageKey);
    try {
      store.set(storageKey, encodeJson([for (final i in keep) {'a': i.aid, 'e': i.e.toJson()}]));
    } catch (_) {/* not serializable: nothing to keep */}
  }

  /// Stops sending: writes the queue to the device and cancels timers. A request in flight still completes.
  void close() {
    _closed = true;
    _timer?.cancel();
    _retryTimer?.cancel();
    _timer = _retryTimer = null;
    persistNow();
  }
}
