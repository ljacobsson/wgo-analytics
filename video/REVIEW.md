# REVIEW — WGO feature film (109.3 s, 1920×1080, 30 fps)

## Creative calls
- Opening (requested by the user): a shopper clicks "Add to cart" on a drawn Acme storefront page; the camera pulls
  back to ~440 similar pages with clicks flashing; the pages fall onto the Live page's world map as pins, which hand
  over to the real recording. Replaced the earlier "What's going on?" title opening.
- Captions: two or three words, quiet plate (38 px, 72% ground, no border). No accent-coloured words anywhere
  (user: highlighted words read as generated); only the logo keeps its gradient.
- "The features you expect from a paid SaaS, but open source" has its own screen before the end card.
- Live scene slowed (11 s, ~1.4 s camera moves, long holds on the counters and the map).
- Every product screen is a real capture of the dashboard in mock mode (`VITE_MOCK=1`), 2× density, seeded with
  goals, triggers and two kiosks through the mock API. Live and the kiosk's Live screen are real screen
  recordings (Chrome screencast, ~13 fps source, encoded to 30 fps).
- Text on screen comes from README.md / FEATURES.md / the kiosk script: the script tag, the three OTEL env vars,
  the webhook payload fields and signature header, the MCP example conversation and `claude mcp add` command,
  the kiosk script's own `say`/`ok` lines, `npm run setup`. The Pi model/RAM line in the console and the webhook
  URL `hooks.acme.dev` are illustrative.
- Drawn (no source exists): the Raspberry Pi 4 board close-up, the office (wall, window, sideboard, plant,
  poster, wall-mounted TV), the AWS diagram, the MCP chat client (layout drawn, copy verbatim from FEATURES.md).
- Transitions, each caused on screen: pages falling into the map, whips, zoom-through the script tag, click match cuts
  (goal row → funnel, trace row → waterfall), iris from "Create trigger" and "View logs for this trace", colour
  flood into the chat, vertical tilt up the HDMI cable to the wall TV, dip cuts.

## Measured vs looked at
- `hyperframes check`: 0 errors. Snapshot review sheets (beats, seams, phone) looked at; kiosk scene spot-checked
  at 73.9 / 75.5 / 77.2 / 79.6 / 83.2 s.
- Silent: no music source was available (no HeyGen sign-in). Nobody heard anything because there is nothing to hear.

## Warnings kept on purpose
- `film_silent`: see above. Add a bed with `/media-use` (music) and clicks on the cursor clicks.
- `line_unread` on the Pi console lines: they are terminal texture; the caption carries the message.
- `line_unread` on the MCP answer (38 words, verbatim): it streams in and holds ~5 s (`data-hold`); the reader
  gets the gist, not every word.
- `text_below_floor` on the console text when the TV is seen wide (it is pushed in to readable size while it types).
- `nested_media_start_basis_ambiguous` on the kiosk's Live video: the start is intentionally scene-local (10.9 s);
  verified on a snapshot at 83.2 s.

## Weakest shot / next
- The Live recordings are ~13 fps sources, so map pings step slightly. A higher-fps capture (or Playwright
  `recordVideo` at a higher bitrate) would smooth them.
- Logs and Metrics are one push each; a filter click (Error+ / p95) would make them act like the other scenes.
- Clicks, Network and Events pages are not shown (Overview/Live/Errors cover their data).
