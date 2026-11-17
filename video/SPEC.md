# SPEC — WGO feature film

GOAL:    a developer finishes knowing WGO shows web analytics, live activity, errors, goals, triggers, traces,
         logs, metrics, MCP, a phone widget and a Raspberry Pi wall screen, all self-hosted in their AWS.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps
TIME:    96.5 s x 30 = 2895 frames. Silent (no music source available).
LOOK:    ground #0a0a0f (the dashboard's --bg); ink #ececf1; muted #8d8da0; accent gradient #8b7cf6 → #22d3ee
         (the logo's), on one word per caption, the ping, the mark. Display: Inter 800, captions 56 px,
         tracking -2%; hero question 168 px, tracking -4%. Code: JetBrains Mono 500, 34–38 px.
         Medium: the product's own screens (real captures from mock mode at 2×), shown at 1.0–1.8×.
         Caption plate: solid #0a0a0f at 94%, 1 px #2a2a38 border, radius 14 px, shadow 0 24 60 rgba(0,0,0,.55),
         bottom-left at (96, 96 from bottom).
         Office world: plaster wall #e8e3da → #d6cfc3, window daylight from the left, walnut sideboard
         #7a4e31, oak floor #b98f66; TV bezel #111 12 px with a wall shadow 0 30 50 rgba(0,0,0,.35).
         Chat world: #f4f3ef ground, ink #1b1b22.
OBJECTS: Raspberry Pi: green PCB #1d6b37 with mounting holes, silver SoC, 2×20 gold GPIO header, USB/Ethernet
         blocks on one edge, micro-HDMI ports, red PWR and green ACT LEDs. Wall TV: thin black bezel, mounted
         (no stand), HDMI cable running down the wall to the Pi on the sideboard. Phone: the real widget render.
MOTION:  arrive expo.out / power4.out 0.5–0.8 s; camera power2.inOut 0.7–1.0 s; zoom-through / exit power3.in
         0.35–0.45 s; whips 0.3 s with 16 px horizontal blur. Caption words: blur 6→0, opacity 0→1, 0.13 s,
         0.067 s apart; exit blur-out 0.2 s.
SHOTS:   see the scene list in index.html (data-start per host). Each scene: one camera move, one caption.
BANNED:  glow/bloom/particles; three cards in a row; titles that move after landing; logo docked in a corner;
         invented UI (every product screen is a capture); every scene entering the same way; bounce on UI.
QA:      0.0 (question visible), 3.5 (map), 7 (snippet typed), 18 (live map), 25 (funnel), 44 (waterfall),
         60 (MCP answer), 66 (phone), 72 (Pi close-up), 78 (TV kiosk), 88 (AWS), 95 (end card).
