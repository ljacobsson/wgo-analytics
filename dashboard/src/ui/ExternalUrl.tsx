import type { ReactNode } from 'react';
import { cn } from '../lib/format';

/**
 * `s` when it is a whole http(s) URL, else null. Event and log values come from the tracked sites, so only
 * these two schemes ever become links (never `javascript:` and the like).
 */
export function httpUrl(s: string | null | undefined): string | null {
  if (!s || !/^https?:\/\/\S+$/i.test(s.trim())) return null;
  try {
    const u = new URL(s.trim());
    const host = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i.test(u.hostname); // not "(direct)" and the like
    return (u.protocol === 'http:' || u.protocol === 'https:') && host ? u.href : null;
  } catch { return null; }
}

/** A link that opens `href` in a new tab without handing it this page, and doesn't toggle the row it sits in. */
export function NewTabLink({ href, children, className, title }: { href: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title ?? href} onClick={(x) => x.stopPropagation()}
      className={cn('hover:text-accent hover:underline', className)}>{children}</a>
  );
}

/** `value` as a link when it is an http(s) URL, else as plain text. */
export function MaybeUrl({ value, className }: { value: string; className?: string }) {
  const href = httpUrl(value);
  return href ? <NewTabLink href={href} className={cn('text-accent', className)}>{value}</NewTabLink> : <>{value}</>;
}

// trailing punctuation usually ends the sentence, not the URL
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/gi;

/** Free text (a log body) with every http(s) URL in it made a link. */
export function Linkified({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const href = httpUrl(m[0]);
    if (!href) continue;
    out.push(text.slice(last, m.index), <NewTabLink key={m.index} href={href} className="text-accent">{m[0]}</NewTabLink>);
    last = m.index + m[0].length;
  }
  if (!out.length) return <>{text}</>;
  out.push(text.slice(last));
  return <>{out}</>;
}
