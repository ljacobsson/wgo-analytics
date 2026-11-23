# WGO feature film: three storylines

The one thing: WGO shows what's going on in your web app and the services behind it, from a visitor's
click down to the backend trace, in your own AWS account.

## A. "14:07" (recommended)

Device: a moment in someone's day. Form: object-to-object chain.

A Slack message lands: "POST /api/checkout failing" (a real WGO trigger). We follow that one failed request
through WGO: the HTTP errors tile spikes, **Why?** names the release, the failed request opens its backend
trace (8–10 s waiting on the card processor, then a 502), the trace opens the visitor's session recording,
and the same question asked to Claude over MCP comes back with the same answer. Fixed: the office TV kiosk
and the Android widget go back to calm. Every shot ends on the thing that opens the next.

- First 2 s: a phone-sized Slack notification fills the frame, "14:07 · WGO · POST /api/checkout: 41 failed
  requests in the last hour", and the number ticks up.
- Beats: alert → the tile spikes → Why? → request → trace waterfall → session replay → ask Claude →
  fix ships, TV and widget calm → "Deploy it to your own AWS account" → WGO mark + `npm run deploy`.
- Look: the dashboard's own dark UI at 1.6–2× scale on a warm off-black desk ground; the logo's
  violet-to-cyan line is the only accent, used for the request's path.
- Sound: a low, tense pulse under the alert that opens up at the fix; clicks on real clicks, a riser into
  the end card.

## B. "One click, all the way down"

Device: one object travels. Form: an endless zoom.

A visitor clicks "Buy" on a storefront. The camera dives into the click: it becomes a dot on the live
visitor map, the map zooms into the Live counter, the counter into the network request, the request into
its trace span, the span into its log line, and the log line into the S3 and Lambda boxes inside your own
AWS account. Then it pulls all the way back out onto a phone widget and a TV.

- First 2 s: a cursor clicks a real-looking "Buy" button and the camera is already falling into it.
- Beats: click → map → live counter → request → trace → log → your AWS account → pull back to phone,
  TV, dashboard → mark.
- Look: each zoom level is its own world (storefront white, map dark, waterfall, AWS diagram); the click's
  dot is the one carrier the eye follows.
- Sound: a continuous rising drone that steps up a key at each dive; a single impact at the pull-back.

## C. "Ask it anywhere" (the bold one)

Device: type carries the argument. Form: split screen to one, cut on the beat.

Giant kinetic type asks "What's going on?" and five real surfaces answer on the beat: the Android home-screen
widget, an office TV kiosk, a Slack trigger, a Claude chat over MCP, the `wgo` CLI. They tile into a split
screen, then collapse into the one dashboard that feeds them all.

- First 2 s: "What's" fills the frame, "going on?" cuts in, and the widget's live number already sits
  inside the "o".
- Beats: the question → five answers, one per bar → split screen → collapse to the dashboard → "Your data,
  your AWS account" → mark.
- Look: flat colour fields from the brand's violet and cyan against the dark UI, a heavy grotesque at
  20% of frame height.
- Sound: a 120 bpm driving bed, hard cuts on the bar, no effects except the collapse impact.
