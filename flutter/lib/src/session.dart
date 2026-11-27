import 'dart:convert';

import 'storage.dart';
import 'util.dart';

class _Rec {
  _Rec(this.id, this.last, this.sampled);
  final String id;
  int last;
  final bool sampled;
}

/// Anonymous id, user id and the current session (same storage keys and rules as the web SDK).
class Session {
  Session(this.timeout, this.sampleRate, this._store) {
    var a = _store.get('wgo:aid');
    if (a == null || a.isEmpty) {
      a = uuid();
      _store.set('wgo:aid', a);
    }
    aid = a;
    final u = _store.get('wgo:uid');
    uid = u == null || u.isEmpty ? null : u;
    manual = uid != null && _store.get('wgo:um') == '1';
  }

  final Duration timeout;
  final double sampleRate;
  final WgoStorage _store;

  late String aid;
  String? uid;

  /// The user id came from the app's `identify`.
  bool manual = false;
  _Rec? _cur;
  int _wrote = 0;

  _Rec? _read() {
    try {
      final j = jsonDecode(_store.get('wgo:sid') ?? 'null');
      if (j is Map && j['id'] is String && j['last'] is num) {
        return _Rec(j['id'] as String, (j['last'] as num).toInt(), j['smp'] == 1);
      }
    } catch (_) {/* corrupt */}
    return null;
  }

  void _write(_Rec r) {
    _wrote = nowMs();
    _store.set('wgo:sid', jsonEncode({'id': r.id, 'last': r.last, 'smp': r.sampled ? 1 : 0}));
  }

  /// No activity for longer than [timeout]: the next event starts a new session.
  bool get expired {
    final r = _cur ?? _read();
    return r == null || nowMs() - r.last > timeout.inMilliseconds;
  }

  /// Marks activity; rotates the session after [timeout] of inactivity. Sampling is decided once per session.
  ({String id, bool sampled}) touch() {
    final now = nowMs();
    var r = _cur ?? _read(); // the stored one continues a session across an app restart
    var fresh = false;
    if (r == null || now - r.last > timeout.inMilliseconds) {
      r = _Rec(uuid(), now, sampleRate >= 1 || random.nextDouble() < sampleRate);
      fresh = true;
    } else {
      r.last = now;
    }
    _cur = r;
    if (fresh || now - _wrote >= 1000) _write(r);
    return (id: r.id, sampled: r.sampled);
  }

  /// Writes the last activity now (the app is going to the background; storage writes are otherwise throttled).
  void save() {
    final r = _cur;
    if (r != null) _write(r);
  }

  void identify(String id, {bool manual = true}) {
    uid = id;
    _store.set('wgo:uid', id);
    this.manual = manual;
    if (manual) {
      _store.set('wgo:um', '1');
    } else {
      _store.remove('wgo:um');
    }
  }

  /// Forget the user and start over as a new anonymous visitor with a new session (logout).
  void reset() {
    aid = uuid();
    _store.set('wgo:aid', aid);
    uid = null;
    _cur = null;
    manual = false;
    _store.remove('wgo:uid');
    _store.remove('wgo:um');
    _store.remove('wgo:sid');
  }
}
