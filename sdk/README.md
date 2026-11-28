# wgo-sdk

Drop-in browser SDK for WGO web analytics. No runtime dependencies; the gzipped script-tag build is under 10 KB.

## Install

### Script tag

```html
<script src="https://cdn.example.com/wgo.js"
        data-write-key="wk_..." data-endpoint="https://api.example.com" async></script>
```

The script auto-initialises from its own tag and exposes `window.WGO`. Supported attributes:

| Attribute | Meaning |
| --- | --- |
| `data-write-key` (required) | Your write key |
| `data-endpoint` (required) | API base URL; events are POSTed to `<endpoint>/ingest` |
| `data-debug` | Log SDK diagnostics to the console |
| `data-release` / `data-environment` | Attached to every batch (`ctx.release`, `ctx.env`) |
| `data-capture-query-params` | Keep query strings in captured URLs |
| `data-respect-do-not-track` | Disable entirely when the browser sends DNT |
| `data-cookieless` | Store nothing on the device (see `cookieless` below) |
| `data-auto-identify` | Identify logged-in users from your app's JWT (see [Identifying users](#identifying-users)) |
| `data-autocapture` | Comma-separated kinds to capture: `pageviews,clicks,errors,http,vitals`. Unlisted kinds are off; absent = all |
| `data-sample-rate` | `0`..`1`, share of sessions recorded |
| `data-session-timeout` | Inactivity in ms after which a new session starts |
| `data-http-ignore` | Comma-separated URL substrings never reported as failed requests |
| `data-trace-origins` | Comma-separated API URLs (besides your own origin) that get a `traceparent` header (see [Linking requests to backend traces](#linking-requests-to-backend-traces)) |
| `data-trace-propagation="false"` | Don't send `traceparent` headers |
| `data-priority-clicks` | A CSS selector list; matching clicks are sent within a second (for realtime watches) |
| `data-persist="false"` / `data-compress="false"` | Turn off `persist` / `compress` |
| `data-record="false"` | Never record sessions on this site, whatever the project's settings (see [Session recording](#session-recording)) |
| `data-surveys="false"` | Never show the project's surveys on this site (see [Surveys](#surveys)) |

The dashboard's install page builds this tag for you: tick the options you want and copy it.

```js
WGO.track('signup_clicked', { plan: 'pro' })
```

### npm

```sh
npm install ./path/to/wgo/sdk   # not on npm yet
```

```ts
import { init, track, identify, reset, page, captureException, setContext, flush, shutdown } from 'wgo-sdk'

init({ writeKey: 'wk_...', endpoint: 'https://api.example.com', release: '1.4.0' })

identify('user_42', { plan: 'pro' })   // `u` is attached to all subsequent events
reset()                                // on logout: forget the user, continue as a new anonymous visitor
track('checkout_started', { value: 99 })
page()                                 // manual pageview (SPA navigation is automatic)
captureException(err, { orderId: 7 })
setContext({ tenant: 'acme' })         // merged into every batch's ctx
await flush()
shutdown()                             // removes listeners, restores fetch/XHR/history
```

## Identifying users

Events carry an anonymous id per browser (`a`). Once a visitor is identified, every event also carries their
user id (`u`), and the visitor's **earlier anonymous events are attributed to them as well**: the backend
remembers which user each anonymous id turned out to be and resolves `userId` through it when you query, so a
`userId` filter shows the whole visit, including the pages before the login. Each anonymous id belongs to the
first user identified on it.

There are two ways to identify:

* **`identify(userId, traits?)`**: you pass the id. It is remembered on this browser until `reset()`, and a
  token never overrides it.
* **`autoIdentify: true`** (`data-auto-identify` on the script tag): the SDK reads the JWT your app already
  holds and uses the first claim it finds of `email`, `preferred_username`, `upn`, `unique_name`, `username`,
  `cognito:username` and `sub`. It finds tokens:
  * in `localStorage`, `sessionStorage` and readable cookies, as a bare token or inside a JSON value (Amplify /
    Cognito, Auth0, MSAL and Firebase store them like this). The SDK looks when it starts, before each
    pageview, and when another tab changes storage;
  * in the `Authorization` header of your app's `fetch` and XHR requests, as `Bearer …` or a bare JWT (Cognito
    authorizers take the id token without a scheme). A stored token wins over a header token, because access
    tokens often name the user only by an opaque `sub`.

  Tokens are decoded, not verified, and expired tokens are ignored. The `identify` event the SDK sends has
  `traits: { $source: 'jwt' }`. When a token names a different user than before, someone else is using the
  browser: the SDK starts a new anonymous id and session for them. It is off by default because email
  addresses are personal data.

Call **`reset()`** when a user logs out. It sends the queued events, then forgets the user id and continues with
a new anonymous id and session, so whoever uses the browser next isn't counted as the previous user.

Importing the package is SSR-safe (nothing touches `window`/`document` until `init`, which is a no-op on the server). Calling `init` twice warns and is ignored.

### Frameworks, tag managers and troubleshooting

The script finds its configuration on any `<script data-write-key data-endpoint>` tag, so it also works
when a framework or tag manager re-creates the element. Loading it more than once is harmless: all
copies share one client. If you can't put attributes on the tag, set a global before the script loads:

```html
<script>window.WGOConfig = { writeKey: 'wk_…', endpoint: 'https://…' }</script>
```

If nothing shows up, run `WGO.status()` in the browser console. It returns
`{ initialized, disabled, endpoint, queued }`. When the SDK loads without finding any configuration, it
logs a `[wgo] loaded but not initialised` warning. Add `data-debug` to the tag to log every send.

## Cookieless mode

```html
<script src="…/wgo.js" data-write-key="wk_…" data-endpoint="https://…" data-cookieless async></script>
```

or `init({ …, cookieless: true })`. The SDK sets no cookies in any mode. With `cookieless` it also writes
nothing to `localStorage` or `sessionStorage`: the anonymous id, session and user id live in memory, and unsent
events aren't saved (`persist` is forced off). The cost:

* Every page load is a new visitor and session, so visitor and session counts go up and funnels and paths
  break at full page loads. A single-page app keeps one session while the tab is open.
* Events still queued when the page closes while offline are lost.
* Identified users are forgotten on reload: call `identify()` on every page load.

`autoIdentify` still works in this mode, but it reads your app's tokens from storage and cookies. Leave it
off if the SDK shouldn't touch the device's storage at all.

## Config

Only `writeKey` and `endpoint` are required.

| Option | Default | Description |
| --- | --- | --- |
| `writeKey` | | Write key |
| `endpoint` | | API base URL (trailing slash ignored) |
| `autocapture` | all `true` | `{ clicks, errors, http, pageviews, vitals }` |
| `flushInterval` | `5000` | Max latency (ms) for normal events, measured from the oldest unsent event |
| `priorityFlushDelay` | `1000` | Max latency once an error, http_error or priority click is queued |
| `maxBatchSize` | `50` | Events per batch; reaching it flushes |
| `maxBatchBytes` | `60000` | Max serialized batch size; ~80% queued flushes |
| `maxQueueSize` | `1000` | Queue cap; oldest events are dropped first |
| `maxRetries` | `6` | Retries before a batch is dropped (backoff 1s, 2s, 4s ... capped at 60s, with jitter) |
| `cookieless` | `false` | Keep the anonymous id, session and user id in memory and never touch `localStorage`. Every page load is a new visitor and session; call `identify()` on each load. Forces `persist: false` |
| `persist` | `true` | Mirror the unsent queue to `localStorage` (`wgo:q:<writeKey>`) |
| `sessionTimeout` | `1800000` | Inactivity (ms) after which a new session starts |
| `sampleRate` | `1` | 0..1, decided once per session |
| `httpIgnore` | `[]` | Strings (substring match) or RegExps of URLs never reported |
| `tracePropagation` | `true` | Send a W3C `traceparent` header with same-origin requests, so a failed request links to its backend trace ([details](#linking-requests-to-backend-traces)) |
| `traceOrigins` | `[]` | Other API URLs that get the header too: strings (substring match) or RegExps. Their CORS must allow `traceparent` |
| `captureQueryParams` | `false` | Keep query strings in URLs (privacy default: stripped) |
| `compress` | `true` | gzip payloads over 1 KB when `CompressionStream` exists (see note) |
| `beforeSend` | | `(event) => event \| null` to modify or drop events |
| `respectDoNotTrack` | `false` | Do nothing if the browser sends Do Not Track |
| `release`, `environment` | | Attached to `ctx` |
| `debug` | `false` | Console diagnostics |
| `priorityClicks` | `[]` | CSS selectors; matching clicks use priority latency (for realtime watches) |
| `autoIdentify` | `false` | Use the email or username in your app's JWT as the user id ([details](#identifying-users)) |
| `record` | `true` | Follow the project's [session recording](#session-recording) settings; `false` never records |

**Compression and CORS.** Uncompressed batches are sent as `text/plain;charset=UTF-8`, a CORS simple request (no preflight). Compressed batches use `application/octet-stream`, which browsers preflight cross-origin; the server must answer the `OPTIONS` request, or set `compress: false`. The backend detects gzip by its magic bytes (`1f 8b`). Beacon sends are never compressed.

## Linking requests to backend traces

The SDK sends a W3C `traceparent` header with the page's own requests (fetch and XHR), and a failed request
reports the trace id it sent. When your backend sends OpenTelemetry traces to the same WGO project, the failed
request opens its backend trace, with the browser request as the root span, and the trace links back to the
session and its recording.

* **Same-origin requests only, by default.** A custom header on a cross-origin request makes the browser send a
  CORS preflight, which an API that doesn't allow the header would reject. List other APIs in `traceOrigins`
  (`traceOrigins: ['https://api.example.com/']`, or `data-trace-origins="https://api.example.com/"`) after adding
  `traceparent` to their `Access-Control-Allow-Headers`.
* **The header is sampled** (flags `01`). A backend using OpenTelemetry's default parent-based sampler records every
  request the browser starts, whatever its own sample ratio.
* A request that already has a `traceparent` (your own browser OpenTelemetry) keeps it, and `no-cors` requests are
  left alone. Turn it off with `tracePropagation: false` or `data-trace-propagation="false"`.

## Delivery

* One request in flight at a time; batches never exceed `maxBatchSize` / `maxBatchBytes`.
* The flush deadline is a max latency: new events never postpone it, priority events can only pull it in.
* When the page is hidden or unloaded, everything is flushed at once via `navigator.sendBeacon` (fallback: `fetch` with `keepalive`), in chunks under 60 KB.
* 2xx removes the batch. 429, 5xx and network errors retry with backoff; other 4xx drop the batch. Nothing is sent while `navigator.onLine === false`; sending resumes on the `online` event.
* Identical errors within 5 s are coalesced into one event with a `count`; at most 30 error events per minute.
* The SDK ignores its own ingest requests in the fetch/XHR interceptors and never throws into the host app.

## Session recording

Project owners turn recording on in the dashboard (Recordings, then Settings). It's off by default, and the snippet stays the same.
On each page load the SDK asks `GET <endpoint>/replay/config?k=<writeKey>` (cached for a minute) whether and what to record:
a share of sessions, and triggers (a page, a click on a CSS selector, a custom event or an error) that record a session the sample
didn't pick. Only then, and only for a session that may be recorded, it loads the recorder, `wgo-replay.js` (about 9 KB gzipped),
from next to `wgo.js`.

There is no video. The recorder sends snapshots of the page as HTML (gzipped, taken on load, on navigation and when the page
changes after an interaction, without scripts or form values), and between them the pointer position, clicks, scrolling, viewport
size and form field lengths. A typical session is a few kilobytes per page.

The recorder also notes hovers: when the mouse rests on a clickable element, image or field for 300 ms or more, it records the
element's selector, how long, and the same label and `data-track` name a click there would report (no label when the project
masks all text; `data-wgo-ignore` elements are skipped). They let you find recordings by behaviour, such as "hovered the buy
button but never clicked it" (the `find_recordings` MCP tool). Touch devices have no hovers.

* Before sending anything, the recorder asks `POST <endpoint>/replay/start` for a slot. The server grants it within the project's
  per-hour and per-day limits, and drops recordings of sessions without one.
* With triggers set, the recorder keeps the last minute in memory until one matches. The recording then starts with what led up to it.
* Automated browsers (`navigator.webdriver`) are never recorded.
* Opt out on a site with `data-record="false"` (`record: false`). `respectDoNotTrack` turns recording off along with everything else.
* In cookieless mode, the "this session is recorded" flag is kept in memory. Otherwise it's in `sessionStorage` (`wgo:rec:<session id>`).

## Surveys

Surveys are built in the dashboard (Surveys): single and multiple choice, short and long text, yes/no, ratings
(5 stars or 1 to 10) and Net Promoter Score questions. When a project has active ones, the config request the SDK
already makes on each page load (`GET <endpoint>/replay/config`) says so, and the SDK loads `wgo-surveys.js` (about
6 KB gzipped) from next to `wgo.js`. That script fetches the active surveys from `GET <endpoint>/surveys/config?k=<writeKey>`
(cached for a minute) and shows them. There's nothing to add to your site:

* A **floating card** slides in at a bottom corner. An **inline** survey is rendered into the first element matching its
  CSS selector, so add that element (e.g. `<div id="feedback"></div>`) where it should appear. When the element shows up
  later (single-page apps), the survey waits for it.
* A floating survey can start as a slim bar with just the current question, which the visitor taps to open. By default
  it does on phones (screens up to 640px wide); a survey can set it to always or never. The expanded card has a button
  to shrink it back, and answers given so far are kept.
* **Targeting**: path globs (`/pricing`, `/docs/*`; none means every page), and any of a delay in seconds, a scroll depth
  and an event trigger. All the conditions that are set must be met on the same page. Single-page app navigations
  start over.
* An **event trigger** is a set of event filters, like the dashboard's filter bar, that one of the SDK's events on the
  page must match: a click (`type` click, `trackName` buy), a custom event (`type` custom, `name` checkout_completed,
  `props.props.plan` pro), a JavaScript error, a failed request (`httpStatus` ≥ 500) or an identify. The SDK checks it in
  the browser, so the fields are the ones it knows when the event happens: `type`, `path`, `url`, `title`, `referrer`,
  `selector`, `elementText`, `elementTag`, `trackName`, `name`, `errorMessage`, `errorSource`, `httpMethod`, `httpUrl`,
  `httpStatus`, `durationMs`, `userId` and `props.<path>`. Events from before `wgo-surveys.js` loaded count too.
* **Frequency**, remembered per browser in `localStorage` (`wgo:sv`, in memory in cookieless mode): once per visitor,
  until answered (a closed survey comes back next session), or on every matching page view. At most one floating survey
  is open at a time.
* `WGO.showSurvey('<survey id>')` (`showSurvey` in the npm package) opens an active survey from your code, wherever its
  targeting would show it. The frequency still applies.
* Answers go to `POST <endpoint>/surveys/respond` with the visitor's anonymous id, user id, session and page. They're
  kept until the survey is deleted, not subject to the raw data retention. The SDK also sends custom events
  `survey_shown`, `survey_dismissed` and `survey_sent` with props `survey_id` and `survey_name`, so surveys work in
  goals, funnels and triggers.
* Surveys render in a shadow root: your page's CSS doesn't change them, and theirs doesn't leak into your page.
  Sessions left out by `sampleRate` get no surveys.
* Opt out on a site with `data-surveys="false"` (`surveys: false`).

## Source maps

Minified stacks are hard to read. Upload your source maps and the dashboard (and the MCP server) show original file names, lines and function names, with the surrounding code.

1. Build with hidden source maps, so the bundles don't point to them: Vite `build: { sourcemap: 'hidden' }`, webpack `devtool: 'hidden-source-map'`.
2. Set `release` in `init()` (or `data-release`) to something unique per deploy, such as the git sha.
3. After the build, upload the maps with the [`wgo-sourcemaps`](../sourcemaps/README.md) CLI. The upload key is in the dashboard under Settings, Source maps (owners only) and is a CI secret, not the write key:

```sh
npx wgo-sourcemaps --endpoint https://wgo.example.com --key uk_... --release 1.4.0 dist/
```

It uploads every `*.js.map` under the folders you give it, and exits non-zero if any upload fails. `WGO_ENDPOINT`, `WGO_UPLOAD_KEY` and `WGO_RELEASE` work as environment variables. Maps are matched by the script's file name (`index-abc123.js`) and the release; maps uploaded without a release are the fallback. Don't deploy the `.map` files to your site.

When a stack has no maps, the dashboard says "Source maps missing". For a one-off upload without a key, connect WGO's MCP server to Claude Code and ask it, in the app's repository, to build with source maps and upload them: the `upload_sourcemaps` tool returns a `curl` command with upload URLs that work for 10 minutes. Any project member can use it.

## Privacy: data attributes

| Attribute | Effect |
| --- | --- |
| `data-track="name"` (or `data-wgo="name"`) | Makes the element a click target and sets `name` on its click events (nearest ancestor wins) |
| `data-wgo-ignore` | Clicks on the element or any descendant are never captured |
| `data-wgo-mask` | Click text is omitted for the element and its descendants. In recordings, their text shows as `*` |
| `data-wgo-block` | Recordings show the element as an empty box of the same size (images, maps, anything private) |

### Dead clicks

A click on a link, button, `[role=button]` or `input[type=submit|button|image]` gets `dead: 1` when nothing happens
within one second: no DOM mutation anywhere in the document (children, attributes or text) and no change of the page URL.
Links with `target="_blank"` or `download`, and `mailto:` and `tel:` links, are never flagged, and neither are clicks on
other elements. The flag is only set while the click is still queued (not yet sent), and one watch runs at a time: a new
click replaces the pending one. Rage clicks (three or more within a second) are reported as before.

Input values are never captured: recordings show one `•` per typed character. Click text is also omitted for `input`, `textarea`, `select`, `contenteditable` and password-like elements.

## Wire format

`POST <endpoint>/ingest`, body is JSON (optionally gzipped):

```ts
interface Batch { k: string /* writeKey */; a: string /* anonymousId */; sentAt: number; ctx: Ctx; e: WireEvent[] }
interface Ctx { sdk: 'wgo-js/0.1.0'; ua?: string; lang?: string; sw?: number; sh?: number; tz?: string; release?: string; env?: string; [k: string]: unknown }
interface WireEvent {
  id: string                // uuid v4
  t: 'pageview' | 'click' | 'error' | 'http_error' | 'custom' | 'vitals' | 'identify'
  ts: number                // ms epoch when it happened
  s: string                 // session id
  u?: string                // user id, once identified
  url: string; path: string; title?: string
  ref?: string              // pageview only
  d?: Record<string, unknown>
}
```

Per-type `d`:

| `t` | `d` |
| --- | --- |
| `click` | `{ sel, tag, text?, name?, href?, x, y, vw, vh, rage? }` |
| `error` | `{ msg, stack?, src?, line?, col?, kind: 'error'\|'rejection'\|'resource'\|'manual', count?, extra? }` |
| `http_error` | `{ method, url, status /* 0 = network failure */, statusText?, dur, kind: 'fetch'\|'xhr' }` |
| `custom` | `{ name, props? }` |
| `vitals` | `{ ttfb?, fcp?, lcp?, cls?, inp?, load? }` (ms, except `cls`) |
| `identify` | `{ traits? }` |

For SPA navigations `ref` is the previous page URL; for the initial pageview it is `document.referrer`. All URLs have their query string stripped unless `captureQueryParams` is on.

Types are exported from the package (`WireEvent`, `Batch`, `Ctx`, `Config`, ...).

## Development

```sh
npm install && npm run typecheck && npm test && npm run build
```
