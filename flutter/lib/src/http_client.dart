import 'package:http/http.dart' as http;

import 'client.dart';
import 'wgo.dart';

/// An `http.Client` that reports failed requests (status >= 400, or no response) as `http_error` events and sends a
/// W3C `traceparent` header, so a failed request opens its backend trace in WGO.
///
/// ```dart
/// final api = WgoHttpClient();          // or WgoHttpClient(inner: yourClient)
/// final res = await api.get(Uri.parse('https://api.example.com/orders'));
/// ```
///
/// It uses the client `Wgo.init` started (or [client]); without one it just passes requests through.
class WgoHttpClient extends http.BaseClient {
  WgoHttpClient({http.Client? inner, this.client}) : _inner = inner ?? http.Client();

  final http.Client _inner;

  /// The SDK client to report to; defaults to `Wgo.client`.
  final WgoClient? client;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final c = client ?? Wgo.client;
    if (c == null || c.stopped) return _inner.send(request);
    final url = request.url.toString();
    String? tp;
    try {
      final has = request.headers.keys.any((k) => k.toLowerCase() == 'traceparent');
      tp = has ? null : c.traceparent(url);
      if (tp != null) request.headers['traceparent'] = tp;
    } catch (_) {
      tp = null; // a finalized request: send it as it is
    }
    final report = c.cfg.captureHttpErrors && c.reportsUrl(url);
    if (!report) return _inner.send(request);
    final sw = WgoClient.stopwatch();
    void failed(int status, String? text) => c.captureHttpError(
        method: request.method, url: url, status: status, statusText: text, duration: sw.elapsed, traceparent: tp);
    try {
      final res = await _inner.send(request);
      if (res.statusCode >= 400) failed(res.statusCode, res.reasonPhrase);
      return res;
    } catch (err) {
      failed(0, err.runtimeType.toString());
      rethrow;
    }
  }

  @override
  void close() => _inner.close();
}
