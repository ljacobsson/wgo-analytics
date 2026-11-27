/// Event types the WGO backend accepts (`t` on the wire).
abstract final class WgoEventType {
  static const pageview = 'pageview';
  static const click = 'click';
  static const error = 'error';
  static const httpError = 'http_error';
  static const custom = 'custom';
  static const vitals = 'vitals';
  static const identify = 'identify';
}

/// One event, as sent to `POST <endpoint>/ingest` (the same wire format as the web SDK).
///
/// `beforeSend` receives these and may change any field.
class WgoEvent {
  WgoEvent({
    required this.id,
    required this.type,
    required this.ts,
    required this.session,
    this.user,
    required this.url,
    required this.path,
    this.title,
    this.ref,
    this.data,
  });

  /// UUID v4; the backend drops duplicates by id, so a retried batch is stored once.
  String id;

  /// One of [WgoEventType].
  String type;

  /// When it happened, ms since the epoch.
  int ts;

  /// Session id.
  String session;

  /// User id, once identified.
  String? user;

  /// `app:/<screen>` for apps.
  String url;

  /// The screen's route name, e.g. `/settings`.
  String path;
  String? title;

  /// The previous screen's url (pageviews only).
  String? ref;

  /// Per-type payload (`d` on the wire).
  Map<String, Object?>? data;

  Map<String, Object?> toJson() => {
        'id': id,
        't': type,
        'ts': ts,
        's': session,
        if (user != null) 'u': user,
        'url': url,
        'path': path,
        if (title != null) 'title': title,
        if (ref != null) 'ref': ref,
        if (data != null) 'd': data,
      };

  /// An event read back from the persisted queue, or null when it isn't one.
  static WgoEvent? fromJson(Object? j) {
    if (j is! Map) return null;
    final id = j['id'], t = j['t'], ts = j['ts'], s = j['s'], url = j['url'], path = j['path'], d = j['d'];
    if (id is! String || t is! String || ts is! num || s is! String || url is! String || path is! String) return null;
    return WgoEvent(
      id: id,
      type: t,
      ts: ts.toInt(),
      session: s,
      user: j['u'] is String ? j['u'] as String : null,
      url: url,
      path: path,
      title: j['title'] is String ? j['title'] as String : null,
      ref: j['ref'] is String ? j['ref'] as String : null,
      data: d is Map ? d.map((k, v) => MapEntry('$k', v)) : null,
    );
  }
}
