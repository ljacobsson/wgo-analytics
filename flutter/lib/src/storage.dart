import 'package:shared_preferences/shared_preferences.dart';

/// Where the SDK keeps the anonymous id, session, user id and unsent events. Reads are synchronous; writes may
/// complete later. Implementations must never throw.
abstract class WgoStorage {
  String? get(String key);
  void set(String key, String value);
  void remove(String key);
}

/// Keeps everything in memory: nothing is written to the device (`memoryOnly`), and tests.
class MemoryStorage implements WgoStorage {
  final Map<String, String> _m = {};

  @override
  String? get(String key) => _m[key];

  @override
  void set(String key, String value) => _m[key] = value;

  @override
  void remove(String key) => _m.remove(key);
}

/// [WgoStorage] on `shared_preferences`. Reads come from its in-memory cache; writes go to disk in the background.
class SharedPreferencesStorage implements WgoStorage {
  SharedPreferencesStorage._(this._p);

  final SharedPreferences _p;

  /// The device's preferences, or [MemoryStorage] when the plugin isn't available.
  static Future<WgoStorage> open() async {
    try {
      return SharedPreferencesStorage._(await SharedPreferences.getInstance());
    } catch (_) {
      return MemoryStorage();
    }
  }

  @override
  String? get(String key) {
    try {
      return _p.getString(key);
    } catch (_) {
      return null; // a value of another type under our key
    }
  }

  @override
  void set(String key, String value) {
    try {
      _p.setString(key, value).catchError((_) => false);
    } catch (_) {/* never throw into the app */}
  }

  @override
  void remove(String key) {
    try {
      _p.remove(key).catchError((_) => false);
    } catch (_) {/* never throw into the app */}
  }
}
