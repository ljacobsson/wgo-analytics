# wgo_flutter

Flutter SDK for WGO analytics. It sends screen views, taps, errors and failed HTTP requests from iOS, Android,
macOS, Windows and Linux apps to a WGO project, in the same wire format as the [browser SDK](../sdk/README.md), so
they show up on the same dashboard pages.

## Install

The package isn't on pub.dev yet. Depend on it from git:

```yaml
dependencies:
  wgo_flutter:
    git:
      url: https://github.com/ljacobsson/wgo-analytics.git
      path: flutter
```

## Set up

```dart
import 'package:wgo_flutter/wgo_flutter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Wgo.init(const WgoConfig(
    writeKey: 'wk_…',                        // the project's write key, from the dashboard's install page
    endpoint: 'https://wgo.example.com',     // events are POSTed to <endpoint>/ingest
    release: '1.4.0+12',                     // your app version
  ));
  runApp(MaterialApp(
    navigatorObservers: [WgoNavigatorObserver()],
    // …
  ));
}
```

That's the whole integration: from here on, screens, taps and uncaught errors are captured
without further changes. Add `WgoHttpClient` for failed requests and `Wgo.identify` for logged-in users.

Every `Wgo` method is safe to call before `init` finishes: up to 100 calls are kept and replayed once it has.
None of them throw into your app.

## What it captures

| What | How | Event |
| --- | --- | --- |
| Screens | `WgoNavigatorObserver` on your navigator, or `Wgo.screen('/cart')` | `pageview` |
| Taps | every tap on a button, list tile, text field or other tappable widget, with no changes to your widgets | `click` |
| Uncaught errors | `FlutterError.onError` and `PlatformDispatcher.onError`, installed by `init` | `error` |
| Failed requests | requests made through `WgoHttpClient` that get a status of 400 or more, or no response | `http_error` |
| Custom events | `Wgo.track('checkout_started', {'value': 99})` | `custom` |
| Users | `Wgo.identify('user_42', {'plan': 'pro'})` | `identify` |

### Screens

`WgoNavigatorObserver` reports a screen view whenever a page route ends up on top: pushed, replaced, or uncovered
by a pop. Dialogs, bottom sheets and menus aren't screens and are skipped. A screen is named by its
`RouteSettings.name`, so named routes (`MaterialApp.routes`, `Navigator.pushNamed`) work as they are. Routes
without a name are skipped unless you name them:

```dart
WgoNavigatorObserver(nameOf: (route) => route.settings.name ?? route.settings.arguments?.toString())
```

With a router package, pass the observer to the router (for example `GoRouter(observers: [WgoNavigatorObserver()])`).
For screens that aren't routes, such as tabs, call `Wgo.screen('/inbox')` yourself.

Each screen view's `path` is the route name (`/settings`) and its `url` is `app:/settings`. Query strings are
stripped unless `captureQueryParams` is on. When the app comes back after the session timed out, the current
screen is viewed again, so the new session has an entry screen.

### Taps

Taps are captured without touching your widgets. The SDK listens to every pointer event, and for a tap (a touch
or click that didn't move into a drag or scroll) it finds the tappable widget under it: anything with a tap
handler, such as Material and Cupertino buttons, list tiles, chips, tabs, text fields, `InkWell` and your own
`GestureDetector`s. Taps on plain text, disabled buttons and empty space aren't reported.

Each tap is reported like a click on the web:

| Field | Example | From |
| --- | --- | --- |
| `tag` | `ElevatedButton` | the control's widget type |
| `text` | `Pay now` | its visible wording, the way a screen reader finds it: a `Semantics` label, its text, its tooltip or icon label |
| `sel` | `ElevatedButton "Pay now"` | the type with its `ValueKey` (`ElevatedButton#pay`), else its text, else its icon (`IconButton icon:e872`) |

Text fields report their label (`TextField "Email"`), never what was typed. Three or more taps on the same control
within a second are one rage click. The lookup runs on taps only, not on scrolls, and takes well under a
millisecond.

Three widgets adjust what's reported, like the web SDK's data attributes:

```dart
WgoTrack(name: 'checkout', child: FilledButton(onPressed: pay, child: const Text('Pay now')))  // data-track
WgoMask(child: ListTile(title: Text(contact.name), onTap: open))                                 // data-wgo-mask
WgoIgnore(child: SecretMenu())                                                                    // data-wgo-ignore
```

* `WgoTrack` names a control: its taps get `name` and use it as their selector, so the dashboard and live watches
  see `checkout` instead of `FilledButton "Pay now"`. It also makes taps on widgets that aren't tappable count,
  and `priority: true` sends them within a second, for live watches.
* `WgoMask` reports taps inside it without their text: use it for names, amounts and anything else personal.
* `WgoIgnore` drops taps inside it altogether.

Turn automatic capture off with `captureTaps: false`; then only `WgoTrack` widgets report taps. In builds with
`--obfuscate`, widget type names are obfuscated too, so `tag` and `sel` show them obfuscated; keys, text and
`WgoTrack` names are unaffected.

### Errors

`init` reports uncaught errors from the framework (`FlutterError.onError`) and from async code
(`PlatformDispatcher.instance.onError`). The handlers that were there before still run, and `shutdown` puts them
back. Report caught errors with `Wgo.captureException(error, stackTrace, {'orderId': 7})`.

Identical errors within 5 seconds are counted on one event, and at most 30 errors a minute are sent. Errors are
grouped on the dashboard by message and first stack frame. Builds with `--obfuscate` produce stacks without
names; WGO can't symbolicate them yet, so you'll see the raw addresses.

### Failed requests and backend traces

Use `WgoHttpClient` wherever you use an `http.Client`:

```dart
final api = WgoHttpClient();                 // or WgoHttpClient(inner: yourClient)
final res = await api.get(Uri.parse('https://api.example.com/orders'));
```

It reports responses with a status of 400 or more, and requests that got no response (status 0). It also sends a
W3C `traceparent` header. When your backend sends OpenTelemetry traces to the same project, the failed request
opens its backend trace. Apps have no CORS, so every request through the client gets the header; set
`traceOrigins` to limit it to your own APIs. On Flutter web only same-origin requests get it by default, as in the
browser SDK; list other APIs in `traceOrigins` once their CORS allows the `traceparent` header.

With another HTTP library (Dio, for example), do the same from an interceptor:

```dart
final tp = Wgo.traceparent(url);             // null when turned off or not in traceOrigins
if (tp != null) headers['traceparent'] = tp;
// … when it fails:
Wgo.captureHttpError(method: 'GET', url: url, status: 503, duration: elapsed, traceparent: tp);
```

## Identifying users

`Wgo.identify(userId, traits)` attaches `u` to every later event, and the backend attributes the visitor's earlier
anonymous events to the user as well. It is remembered on the device until `Wgo.reset()`. Call `reset` on
logout: queued events are still sent as the previous user, and the app continues as a new anonymous visitor
with a new session.

## Config

Only `writeKey` and `endpoint` are required. Durations are `Duration`s.

| Option | Default | Description |
| --- | --- | --- |
| `captureTaps` | `true` | Report taps on every tappable widget; off: only `WgoTrack` |
| `captureErrors` | `true` | Report uncaught errors |
| `captureHttpErrors` | `true` | Report failed requests made through `WgoHttpClient` |
| `flushInterval` | 5 s | Max latency for normal events, from the oldest unsent event |
| `priorityFlushDelay` | 1 s | Max latency once an error, failed request or priority tap is queued |
| `maxBatchSize` | `50` | Events per batch; reaching it sends at once |
| `maxBatchBytes` | `60000` | Max serialized batch size; about 80% queued sends at once |
| `maxQueueSize` | `1000` | Queue cap; the oldest events are dropped first |
| `maxRetries` | `6` | Retries before a batch is dropped (backoff 1 s, 2 s, 4 s … up to 60 s, with jitter) |
| `persist` | `true` | Keep unsent events on the device (`shared_preferences`) |
| `memoryOnly` | `false` | Store nothing on the device. Every app start is a new visitor and session; call `identify` on each start. Forces `persist` off |
| `sessionTimeout` | 30 min | Inactivity after which a new session starts |
| `sampleRate` | `1` | 0..1, share of sessions recorded, decided once per session |
| `httpIgnore` | `[]` | URLs never reported as failed requests: strings (substring match) or `RegExp`s |
| `tracePropagation` | `true` | Send a `traceparent` header with requests made through `WgoHttpClient` |
| `traceOrigins` | `[]` | When set, only matching URLs get the header (on the web: same-origin only until set) |
| `captureQueryParams` | `false` | Keep query strings in screen and request URLs |
| `compress` | `true` | gzip batches over 1 KB (not on the web) |
| `beforeSend` | | `(WgoEvent e) => e` to change an event, `null` to drop it |
| `release`, `environment` | | Attached to every batch as `ctx.release` and `ctx.env` |
| `debug` | `false` | Print diagnostics with `debugPrint` |

`Wgo.setContext({'tenant': 'acme'})` adds fields to every batch's `ctx`. `Wgo.status()` returns
`{initialized, endpoint, queued}`. `await Wgo.flush()` sends what's queued, and `await Wgo.shutdown()` sends what
it can, removes the SDK's handlers and stops (`init` may be called again afterwards).

## Delivery

* One request in flight at a time. The flush deadline is a max latency: new events never postpone it, and
  priority events can only bring it forward.
* 2xx removes the batch. 429, 5xx, network errors and timeouts (30 s) retry with backoff; other 4xx drop the batch.
* The queue is copied to the device about a second after it changes and when the app goes to the background, so
  events survive the app being closed or killed. They're sent on the next start. A batch that was sent just
  before the app was killed may be sent again; the backend drops the duplicates by event id.
* Going to the background starts a send; coming back skips any retry backoff.

## Devices, platforms and privacy

Each batch carries the language, the screen size in logical pixels and a user agent such as
`wgo-flutter/0.1.0 (iPhone; iOS)`. The dashboard shows these events with the browser "Flutter app", the
operating system, and phone or tablet (a shortest side of 600 logical pixels or more). Nothing else about the
device is collected. As with the web SDK, IP addresses are never stored.

It also runs on Flutter web, with uncompressed batches and the browser's own user agent. For web apps the
[browser SDK](../sdk/README.md) captures more (every click, Web Vitals, session recordings).

## Not yet

* Session recordings and heatmap snapshots: there is no DOM to snapshot.
* Dead clicks (taps after which nothing changes).
* Web Vitals-style app performance (start time, slow frames).
* Symbolication of obfuscated stacks.

## Wire format

Batches are the browser SDK's ([details](../sdk/README.md#wire-format)): `POST <endpoint>/ingest` with
`{ k, a, sentAt, ctx, e: [...] }`, `ctx.sdk` is `wgo-flutter/0.1.0`. Specifics:

| `t` | `d` |
| --- | --- |
| `pageview` | your `properties`, if any; `ref` is the previous screen's url |
| `click` | `{ sel, tag, name?, text?, x, y, vw, vh, rage? }`: see [Taps](#taps); `name` is the `WgoTrack` name; `x`/`y` and `vw`/`vh` in logical pixels |
| `error` | `{ msg, stack?, src?, line?, col?, kind: 'error'\|'manual', count?, extra? }`: `src`/`line`/`col` from the first Dart frame |
| `http_error` | `{ method, url, status, statusText?, dur, kind: 'dart', trace?, span? }` |

## Development

```sh
flutter pub get && flutter analyze && flutter test
```

The [example](example/lib/main.dart) app exercises every capture type. Run `flutter create .` in `example/` once to
add the platform folders, then
`flutter run --dart-define=WGO_WRITE_KEY=wk_… --dart-define=WGO_ENDPOINT=https://wgo.example.com`.
