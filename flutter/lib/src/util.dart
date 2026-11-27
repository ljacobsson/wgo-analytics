import 'dart:convert';
import 'dart:math';

import 'package:clock/clock.dart';

final Random _secure = () {
  try {
    return Random.secure();
  } catch (_) {
    return Random();
  }
}();

/// Non-cryptographic randomness (sampling, retry jitter).
final Random random = Random();

/// A random v4 UUID.
String uuid() {
  final b = List<int>.generate(16, (_) => _secure.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// Milliseconds since the epoch, from `package:clock` so tests can fake it.
int nowMs() => clock.now().millisecondsSinceEpoch;

/// True when [s] contains a string of [list] or matches one of its RegExps.
bool matchesAny(List<Pattern> list, String s) =>
    list.any((p) => p is RegExp ? p.hasMatch(s) : s.contains(p));

int byteLen(String s) => utf8.encode(s).length;

/// `jsonEncode` that copes with values JSON can't hold: `toJson()` when there is one, else `toString()`.
String encodeJson(Object? v) {
  try {
    return jsonEncode(v, toEncodable: _fallback);
  } on JsonUnsupportedObjectError {
    // on the web, NaN and infinities fail without reaching toEncodable
    return jsonEncode(_finite(v), toEncodable: _fallback);
  }
}

Object? _finite(Object? v) => switch (v) {
      double d when !d.isFinite => d.toString(),
      Map m => m.map((k, x) => MapEntry(k, _finite(x))),
      Iterable i => i.map(_finite).toList(),
      _ => v,
    };

Object? _fallback(Object? o) {
  if (o is DateTime) return o.toIso8601String();
  if (o is num) return o.toString(); // NaN and infinities
  if (o is Iterable) return o.toList();
  try {
    final j = (o as dynamic).toJson();
    // its own nested values go through this fallback again; only the top level has to be JSON
    if (j == null || j is String || j is bool || j is List || j is Map || (j is num && j.isFinite)) return j;
  } catch (_) {/* no toJson */}
  return o.toString();
}

String truncate(String s, int max) => s.length > max ? s.substring(0, max) : s;
