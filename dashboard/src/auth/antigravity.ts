import { useEffect, useRef, type RefObject } from 'react';

/**
 * "Anti-gravity" for the sign-in screens: things drift away from the pointer as it comes close and spring back when it
 * leaves. One requestAnimationFrame loop drives every body and runs only while something is moving, so a still page
 * costs nothing. Off for visitors who ask for reduced motion.
 */

export type Pointer = { x: number; y: number } | null;
/** Advances one frame (`n` = 60 Hz frames elapsed, so faster screens don't speed it up); true while still moving. */
type Step = (pointer: Pointer, n: number) => boolean;

const steps = new Set<Step>();
let pointer: Pointer = null;
let raf = 0;
let last = 0;

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function tick(now: number) {
  raf = 0;
  const n = last ? Math.min(4, Math.max(0.25, (now - last) / (1000 / 60))) : 1;
  last = now;
  let moving = false;
  for (const s of steps) moving = s(pointer, n) || moving;
  if (moving) raf = requestAnimationFrame(tick);
  else last = 0;
}
export function kick() { if (!raf) raf = requestAnimationFrame(tick); }

const onMove = (e: PointerEvent) => { pointer = { x: e.clientX, y: e.clientY }; kick(); };
const onGone = () => { pointer = null; kick(); };
const onOut = (e: PointerEvent) => { if (!e.relatedTarget) onGone(); };
const onUp = (e: PointerEvent) => { if (e.pointerType !== 'mouse') onGone(); };

function listen(on: boolean) {
  const m = on ? 'addEventListener' : 'removeEventListener';
  window[m]('pointermove', onMove as EventListener, { passive: true });
  window[m]('pointerdown', onMove as EventListener, { passive: true });
  window[m]('pointerup', onUp as EventListener);
  window[m]('pointercancel', onGone);
  window[m]('blur', onGone);
  window[m]('resize', kick);
  window[m]('scroll', kick, true);
  document[m]('pointerout', onOut as EventListener);
}

/** Registers a step with the shared loop for the lifetime of the component. */
export function useStep(step: Step, enabled = true) {
  const ref = useRef(step);
  ref.current = step;
  useEffect(() => {
    if (!enabled) return;
    const s: Step = (p, n) => ref.current(p, n);
    if (!steps.size) listen(true);
    steps.add(s);
    kick();
    return () => {
      steps.delete(s);
      if (!steps.size) { listen(false); pointer = null; if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
    };
  }, [enabled]);
}

/** The push away from the pointer at distance d: strongest up close, gone at `radius`. */
export const push = (d: number, radius: number, strength: number) => (d >= radius ? 0 : strength * (1 - d / radius) ** 2);

export interface RepelOptions {
  radius?: number;
  strength?: number;
  /** Spring back towards the resting place, per frame. */
  spring?: number;
  damping?: number;
  /** Degrees of tilt per pixel of sideways drift. */
  tilt?: number;
}

/** Makes an element drift away from the pointer (a CSS transform on the element, so don't animate its transform elsewhere). */
export function useRepel<T extends HTMLElement | SVGElement>(ref: RefObject<T | null>, o: RepelOptions = {}) {
  const { radius = 140, strength = 2, spring = 0.06, damping = 0.82, tilt = 0.25 } = o;
  const st = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  useStep((p, n) => {
    const el = ref.current;
    if (!el) return false;
    const s = st.current;
    let fx = 0, fy = 0;
    if (p) {
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - p.x, dy = r.top + r.height / 2 - p.y;
      const d = Math.hypot(dx, dy);
      const f = push(d, radius, strength);
      if (f) { if (d < 0.5) fy = -f; else { fx = (dx / d) * f; fy = (dy / d) * f; } }
    }
    const damp = damping ** n;
    s.vx = (s.vx + (fx - s.x * spring) * n) * damp;
    s.vy = (s.vy + (fy - s.y * spring) * n) * damp;
    s.x += s.vx * n;
    s.y += s.vy * n;
    const moving = Math.abs(s.vx) + Math.abs(s.vy) > 0.01;
    if (!moving && !fx && !fy && Math.abs(s.x) + Math.abs(s.y) < 0.3) { s.x = s.y = s.vx = s.vy = 0; }
    el.style.transform = s.x || s.y ? `translate3d(${s.x.toFixed(2)}px,${s.y.toFixed(2)}px,0) rotate(${(s.x * tilt).toFixed(2)}deg)` : '';
    return moving;
  }, !reducedMotion());
}
