import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * A floating panel anchored to an element, rendered in a portal so table cards with overflow clipping don't cut
 * it off. Closes on outside click, Escape and scrolling of the page behind it.
 */
export function Popover({ anchor, open, onClose, children, align = 'end', width }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; children: ReactNode; align?: 'start' | 'end'; width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const w = panel.current?.offsetWidth ?? width ?? 320;
      const h = panel.current?.offsetHeight ?? 300;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, align === 'end' ? a.right - w : a.left));
      const below = window.innerHeight - a.bottom - 12;
      const top = below >= Math.min(h, 260) || below >= a.top ? a.bottom + 6 : Math.max(8, a.top - 6 - h);
      setPos({ top, left, maxH: Math.max(160, top > a.top ? below : a.top - 14) });
    };
    place();
    const r = requestAnimationFrame(place); // again once the panel has its real size
    return () => cancelAnimationFrame(r);
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const scroll = (e: Event) => { if (!panel.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div ref={panel} onClick={(e) => e.stopPropagation()}
      className="anim-pop fixed z-[60] overflow-y-auto rounded-xl border border-line bg-[var(--raised)] p-3 shadow-2xl"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxWidth: 'calc(100vw - 16px)', maxHeight: pos?.maxH, visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}
