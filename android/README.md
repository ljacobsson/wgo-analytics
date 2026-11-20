# WGO for Android

A home-screen widget showing live stats from a WGO deployment. Users pick a project, a time range and up to 8
stats per widget. The widget adapts to its size: one big number at 2×1, a row of tiles at 4×2, and a hero chart
with a grid at 4×3 and larger. A widget can also show **all projects**: one row per project, busiest first,
with up to 3 built-in stats each. It ships as an APK that the dashboard serves under **Mobile widget**.

## How it fits together

```
Dashboard → Mobile widget                     Phone
  Download APK  ─────────────────────────────▶ install
  Connect a device → POST /api/devices          │
     QR: https://<dash>/pair.html#api=…&token=dt_…   (token in the fragment: never sent to the server)
        └─ "Open in the WGO app" → wgo://pair?… ─▶ MainActivity stores {apiUrl, dashUrl, token}
                                                │
Widget refresh (WorkManager, 15–180 min, or ↻) ─▶ GET {apiUrl}/widget/v1/projects/{pid}/summary
                                                    Authorization: Bearer dt_…
```

- **Device tokens** (`backend/src/lib/devices.ts`) are read-only and per user. They only work on `/widget/v1/*`
  and see the same projects as their user. The database stores only the token's SHA-256. You can revoke a token
  from the dashboard; warm Lambdas notice within 30 seconds.
- **Stats** (`backend/src/lib/widget.ts`) include built-ins such as visitors now, pageviews, sessions, visitors,
  clicks, top page, top country, JS errors, failed API calls, LCP/INP/CLS p75, traces, latency p95, failed spans
  and error logs. Each project also gets its own tracked clicks (`track:<name>`), custom events (`event:<name>`)
  and OTel metrics (`metric:<name>`). Additive stats come from a single scan over 48 buckets: the previous window
  plus the current one, which yields the total, the comparison and the sparkline.
- **All projects** (`GET /widget/v1/overview`) computes the same stats for every project the user can see (up to
  30, four at a time) over one shared window, sorted by the first stat. Only built-in, non-text stats are allowed,
  since tracked clicks, events and metrics differ per project. The widget stores `projectId = "*"` for this mode.
- **Refresh**: Android runs background work at most every 15 minutes, so that's the floor for unattended
  updates. Tapping ↻ fetches immediately, and so does opening the app.

## Code map

| | |
|---|---|
| `widget/StatsWidget.kt` | Glance widget: layouts per size, header, tiles, prompts |
| `widget/WidgetStore.kt` | per-widget config + last data, kept in Glance state so updates always recompose |
| `widget/Refresh.kt` | fetch logic, WorkManager scheduling, the ↻ action |
| `widget/Sparkline.kt` | sparklines rendered to bitmaps (widgets can't draw paths) |
| `widget/Palette.kt` | Dark / Light / Auto / Material You colours |
| `widget/StatsWidgetReceiver.kt` | widget provider; applies config to widgets pinned from inside the app |
| `ui/MainActivity.kt` | pairing (deep link or pasted link), account, add widget, refresh interval |
| `ui/ConfigActivity.kt` | per-widget setup with a live preview of the real numbers |
| `data/` | API client, models, account storage, link parsing |

## Build

```bash
./scripts/build-android.sh      # → dashboard/public/downloads/wgo-android.apk + android.json
```

You need JDK 17+ and the Android SDK (platform 35). The script looks in `$JAVA_HOME`/`$ANDROID_HOME`, then
`~/.local/opt/jdk17` and `~/Android/Sdk`.

The built APK and `android.json` are committed. The app learns its server from the pairing link, so one build works
for every deployment, and `scripts/deploy.sh` uploads the committed APK. To rebuild during a deploy, set
`BUILD_ANDROID=true`. After changing the app, rebuild it and commit both files.

**Signing key:** the first build creates `android/keystore/` (gitignored). Every later build must be signed with
the same key, or installed apps refuse the update. **Back that directory up.** The application id is set once in
`gradle.properties` (`wgo.applicationId`); changing it later produces a separate app.

A deployment that rebuilds with its own key ships an APK that can't update an app installed from the committed
one: phones refuse the update until that app is uninstalled. Pick one source per deployment and stick to it.

## Local development

Debug builds allow plain HTTP, so they can talk to `backend/dev/server.mts`. The emulator reaches your machine
at `10.0.2.2`:

```bash
./gradlew :app:installDebug
TOKEN=$(curl -s -X POST localhost:8787/api/devices -H 'content-type: application/json' -d '{"name":"Emulator"}' | jq -r .token)
adb shell am start -a android.intent.action.VIEW -d "'wgo://pair?api=http%3A%2F%2F10.0.2.2%3A8787&token=$TOKEN'"
```

To try the minified release build against the dev server: `./gradlew :app:assembleRelease -Pwgo.cleartext=true`.
