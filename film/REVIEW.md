# REVIEW: v2 "The grid" (3 x 3)

v1 ("14:07", a single incident followed through the product) is archived in `.v1/`. The person found it too
fast and hard to follow, and asked for a grid of features with a zoom into each for a short promo.

## Creative calls
- Nine features in a 3 x 3 grid, title in a column on the left: Web analytics, Live activity (map), Session
  replay, Goals and funnels, Why? and alerts, Traces/logs/metrics, AI assistant, TV and phone, Costs and budgets.
  Left out: uptime, heatmaps, retention, releases.
- Every promo opens from the box's exact framing and closes back to it, so the zoom in and out are seamless.
  Box covers for the HTML promos (replay, assistant, TV and phone) are snapshots of those promos' own first and
  last frames (`assets/covers/`). Regenerate them if a promo's first or last frame changes.
- Each promo: one title (6 words or fewer), one short subline, one slow camera drift. Text sits on its own
  panel, never over a dimmed screenshot. 6 s each, 6.5 s for Why? (the Slack alert), 10 s for the assistant
  (reading time for the answer).
- The AI assistant is a Claude Code style terminal: the README's question, three real WGO MCP tool calls
  (explain_change, list_failed_requests, get_trace) whose results are the numbers in the captures, and an
  answer that names the cause from the trace (Stripe 402 card_declined, PaymentGatewayError in charge_card,
  api-gateway 502). Then "fix it" is typed before the zoom out. No Claude logo is drawn.
- The trace is a backend-rooted failing checkout trace, so its spans cover the full width (the earlier
  browser-started trace spent 5 s waiting in the browser, which squeezed the backend spans to the left).
- Live map, funnel (a seeded "Checkout completed" goal with three steps) and Costs are new mock captures.
- The end card says `$ npm run deploy`.
- Length 92.7 s.

## Measured vs looked at
- `check` passes. Looked at 15 QA frames across the film. Pixel-diffed the seams where a promo starts and ends
  against the grid: they match apart from the zoom beginning.
- Sound: whooshes on the nine zoom-ins, typing under "fix it", the notification on the Slack alert, a riser into an impact on the logo.
  No music. Placed by measured peak times, not heard.

## Weakest shot
- The length: nine promos at 6 s plus the zooms make 1:33. Promos at 5 s would bring it to about 1:24.
- Three promos use a bottom caption band (goals, traces, TV) and the rest a side panel; goals and traces
  are close together in the order.

## Warnings kept
- `escaped_container` on `#g-cam`: the grid zoom, on purpose.
- `duplicate_media_discovery_risk`: the box covers that are identical at the start and end of a promo.
