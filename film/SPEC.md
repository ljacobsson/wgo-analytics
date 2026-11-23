# SPEC v2: "The grid" (the person's structure)

The first version (storyline A, "14:07") is archived in `.v1/`. The person found it too fast and hard to follow.

GOAL:    a viewer can name WGO's nine main features after one watch, because each one has its own calm promo
         and the grid shows where they are.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps
TIME:    92.7 s. SFX only (no music source yet).

STRUCTURE: a home grid of nine boxes (3 x 3, title column on the left), each showing its feature's real screen. The camera zooms into one
         box until it fills the frame, the promo plays (opens, shows, closes back), and the camera zooms back out
         to the grid. Nine times, in reading order. Then the grid's title becomes the AWS claim, then the end card.
FEATURES: 1 Web analytics · 2 Live activity · 3 Session replay · 4 Goals and funnels · 5 Why? and alerts ·
         6 Traces, logs, metrics · 7 AI assistant (Claude Code terminal, ends on "fix it") · 8 TV and phone ·
         9 Costs and budgets

LOOK:    grid ground #f6f6f8, ink #0e0e14; boxes 400 x 225 (16:9), radius 18, 1px #e3e3ea, shadow
         0 18px 40px rgba(14,14,20,.10); labels Inter 700 34 px; grid title Inter 800 64 px -0.03em.
         Promo panel #0a0a0f 720 px wide beside the screen; promo title Inter 700 68 px, sub Inter 400 32 px
         #a3a2b0. Logo gradient only in the logo.
MOTION:  zoom in 0.9 s power2.inOut, zoom out 0.7 s power2.inOut, others dim to 0.3 while one is chosen.
         Promo: open 0.7 s power3.inOut, title per word 0.13 s / 0.07 s apart at 0.7, sub at 1.4, one slow
         drift (sine.inOut) while text holds, text out at 4.9, close 5.2-5.9 back to the exact cover framing.
TIMING:  intro 0-4.5; each feature: dim 0-0.35, zoom 0.3-1.2, promo (6 s; Why? 6.5, AI 10), zoom out 0.7,
         rest 0.4. Exact times are the D and T arrays in compositions/grid.html. End card 86.7-92.7.
BANNED:  spec.md defaults; pills, chips, coloured words in titles, uppercase eyebrows, numbered labels;
         a title over a dimmed screenshot (text sits on its own panel); cursor gimmicks; fast cutting.
