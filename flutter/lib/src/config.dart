import 'event.dart';

/// SDK configuration. Only [writeKey] and [endpoint] are required.
class WgoConfig {
  const WgoConfig({
    required this.writeKey,
    required this.endpoint,
    this.captureTaps = true,
    this.captureErrors = true,
    this.captureHttpErrors = true,
    this.flushInterval = const Duration(seconds: 5),
    this.priorityFlushDelay = const Duration(seconds: 1),
    this.maxBatchSize = 50,
    this.maxBatchBytes = 60000,
    this.maxQueueSize = 1000,
    this.maxRetries = 6,
    this.persist = true,
    this.memoryOnly = false,
    this.sessionTimeout = const Duration(minutes: 30),
    this.sampleRate = 1,
    this.httpIgnore = const [],
    this.tracePropagation = true,
    this.traceOrigins = const [],
    this.captureQueryParams = false,
    this.compress = true,
    this.beforeSend,
    this.release,
    this.environment,
    this.debug = false,
  });

  /// The project's write key (`wk_…`).
  final String writeKey;

  /// API base URL; events are POSTed to `<endpoint>/ingest`. A trailing slash is ignored.
  final String endpoint;

  /// Report taps on any tappable widget (buttons, list tiles, `InkWell`, `GestureDetector`, text fields …) as
  /// `click` events, with no changes to your widgets. Off: only `WgoTrack` widgets report taps.
  final bool captureTaps;

  /// Report uncaught errors (`FlutterError.onError` and `PlatformDispatcher.onError`). Earlier handlers still run.
  final bool captureErrors;

  /// Report failed requests (status >= 400 or no response) made through `WgoHttpClient`.
  final bool captureHttpErrors;

  /// Max latency for normal events, measured from the oldest unsent event.
  final Duration flushInterval;

  /// Max latency once an error, failed request or priority tap is queued.
  final Duration priorityFlushDelay;

  /// Events per batch; reaching it sends at once.
  final int maxBatchSize;

  /// Max serialized batch size in bytes; about 80% queued sends at once.
  final int maxBatchBytes;

  /// Queue cap; the oldest events are dropped first.
  final int maxQueueSize;

  /// Retries before a batch is dropped (backoff 1s, 2s, 4s … capped at 60s, with jitter).
  final int maxRetries;

  /// Keep unsent events on the device, so they survive the app being closed or offline.
  final bool persist;

  /// Store nothing on the device: the anonymous id, session, user id and queue live in memory (the web SDK's
  /// `cookieless`). Every app start is a new visitor and session; call `identify` on each start. Forces [persist] off.
  final bool memoryOnly;

  /// Inactivity after which a new session starts.
  final Duration sessionTimeout;

  /// 0..1, share of sessions recorded, decided once per session.
  final double sampleRate;

  /// URLs never reported as failed requests: strings (substring match) or RegExps.
  final List<Pattern> httpIgnore;

  /// Send a W3C `traceparent` header with requests made through `WgoHttpClient`, so a failed request links to its
  /// backend trace.
  final bool tracePropagation;

  /// When not empty, only requests to matching URLs (strings: substring match, or RegExps) get the `traceparent`
  /// header. Empty: every request made through `WgoHttpClient` gets it; on Flutter web only same-origin ones, as
  /// a custom header makes the browser preflight cross-origin requests (their CORS must allow `traceparent`).
  final List<Pattern> traceOrigins;

  /// Keep query strings in screen and request URLs (privacy default: stripped).
  final bool captureQueryParams;

  /// gzip batches over 1 KB (not on Flutter web).
  final bool compress;

  /// Change or drop (return null) events before they are queued.
  final WgoEvent? Function(WgoEvent event)? beforeSend;

  /// Attached to every batch (`ctx.release`): the app version, e.g. `1.4.0+12`.
  final String? release;

  /// Attached to every batch (`ctx.env`).
  final String? environment;

  /// Print SDK diagnostics with `debugPrint`.
  final bool debug;
}
