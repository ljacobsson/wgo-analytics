import 'dart:convert';
import 'dart:io' show gzip;

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:wgo_flutter/wgo_flutter.dart';

const endpoint = 'https://wgo.test';

/// A fake ingest endpoint: records every batch and answers with [status] (or throws when it returns -1).
class FakeIngest {
  FakeIngest({this.status = _accept});
  static int _accept(int i) => 202;

  int Function(int request) status;
  final List<http.Request> requests = [];
  final List<Map<String, dynamic>> batches = [];
  final List<int> statuses = [];

  late final MockClient client = MockClient((req) async {
    requests.add(req);
    List<int> bytes = req.bodyBytes;
    if (bytes.length > 1 && bytes[0] == 0x1f && bytes[1] == 0x8b) bytes = gzip.decode(bytes);
    final code = status(requests.length - 1);
    statuses.add(code);
    batches.add(jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>);
    if (code < 0) throw http.ClientException('offline', req.url);
    return http.Response('', code);
  });

  /// Events of batches the server accepted.
  List<Map<String, dynamic>> get events => [
        for (var i = 0; i < batches.length; i++)
          if (statuses[i] >= 200 && statuses[i] < 300) ...(batches[i]['e'] as List).cast<Map<String, dynamic>>()
      ];

  List<Map<String, dynamic>> ofType(String t) => events.where((e) => e['t'] == t).toList();
}

WgoClient newClient(FakeIngest ingest, {WgoStorage? storage, WgoConfig? config}) => WgoClient(
      config: config ?? const WgoConfig(writeKey: 'wk_test', endpoint: endpoint),
      storage: storage ?? MemoryStorage(),
      httpClient: ingest.client,
      context: const {'ua': 'test'},
    );

WgoConfig cfg({
  bool persist = true,
  bool memoryOnly = false,
  int maxBatchSize = 50,
  int maxRetries = 6,
  double sampleRate = 1,
  bool captureQueryParams = false,
  bool tracePropagation = true,
  List<Pattern> traceOrigins = const [],
  List<Pattern> httpIgnore = const [],
  WgoEvent? Function(WgoEvent)? beforeSend,
}) =>
    WgoConfig(
      writeKey: 'wk_test',
      endpoint: '$endpoint/',
      persist: persist,
      memoryOnly: memoryOnly,
      maxBatchSize: maxBatchSize,
      maxRetries: maxRetries,
      sampleRate: sampleRate,
      captureQueryParams: captureQueryParams,
      tracePropagation: tracePropagation,
      traceOrigins: traceOrigins,
      httpIgnore: httpIgnore,
      beforeSend: beforeSend,
      release: '1.2.3',
    );
