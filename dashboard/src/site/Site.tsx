import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { BookOpen, Github } from 'lucide-react';
import { useAuth } from '../auth/cognito';
import { Logo } from '../ui/Logo';
import { Button } from '../ui/kit';
import { CodeBlock } from '../ui/CodeBlock';
import { navigate, useRoute } from '../lib/router';
import { cn } from '../lib/format';

/** The public pages: the docs (docs/Docs.tsx) and the OpenTelemetry guide. Signed out, `#/` is the sign-in screen (auth/AuthScreens.tsx). */

export const REPO_URL = 'https://github.com/ljacobsson/wgo-analytics';
export const SPONSOR_URL = 'https://github.com/sponsors/ljacobsson';
export const repoFile = (path: string) => `${REPO_URL}/blob/main/${path}`;

/**
 * Links to a section of a public page. The app routes on the hash (`#/docs`), so a section is a `?s=` param instead of
 * a `#fragment`. When the section is already on screen, scroll to it without a navigation.
 */
export function sectionHref(page: 'docs', id: string) { return `#/${page}?s=${id}`; }
export function onSectionClick(page: 'docs', id: string) {
  return (e: MouseEvent) => {
    const el = document.getElementById(id);
    const here = (window.location.hash.replace(/^#\/?/, '').split('?')[0] || '') === page;
    if (!el || !here) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', sectionHref(page, id));
  };
}
/** Scroll to the `?s=` section when a public page opens or the param changes. */
export function useSectionScroll() {
  const s = useRoute().params.get('s');
  useEffect(() => {
    if (!s) return;
    const t = setTimeout(() => document.getElementById(s)?.scrollIntoView({ block: 'start' }), 30);
    return () => clearTimeout(t);
  }, [s]);
}

export function useTitle(title: string) {
  useEffect(() => { const prev = document.title; document.title = title; return () => { document.title = prev; }; }, [title]);
}

const NAV: Array<{ label: string; href: string; page: string }> = [
  { label: 'Docs', href: '#/docs', page: '' },
  { label: 'OpenTelemetry', href: '#/docs/opentelemetry', page: 'opentelemetry' },
];

export function SiteHeader() {
  const { signedIn } = useAuth();
  const sub = useRoute().segments[1] ?? '';
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_78%,transparent)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-6">
          <a href="#/docs" aria-label="WGO docs"><Logo size={28} /></a>
          <nav className="flex items-center gap-0.5 text-[13.5px]">
            {NAV.map((n) => (
              <a key={n.label} href={n.href} className={cn('rounded-lg px-3 py-1.5 transition-colors hover:bg-[var(--hl)] hover:text-fg', sub === n.page ? 'text-fg' : 'text-muted')}>{n.label}</a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-1.5">
          <a href={REPO_URL} target="_blank" rel="noreferrer" aria-label="WGO on GitHub"
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-[var(--hl)] hover:text-fg">
            <Github size={17} /><span className="hidden sm:inline">GitHub</span>
          </a>
          {signedIn
            ? <Button variant="primary" onClick={() => navigate('/')}>Open dashboard</Button>
            : <Button onClick={() => navigate('/signin')}>Sign in</Button>}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const col = (title: string, links: Array<[string, string, boolean?]>) => (
    <div>
      <p className="text-[13px] font-medium text-faint">{title}</p>
      <ul className="mt-4 space-y-2.5 text-[13.5px]">
        {links.map(([label, href, ext]) => (
          <li key={label}><a href={href} {...(ext ? { target: '_blank', rel: 'noreferrer' } : {})} className="text-muted transition-colors hover:text-fg">{label}</a></li>
        ))}
      </ul>
    </div>
  );
  return (
    <footer className="border-t border-line bg-[color-mix(in_srgb,var(--bg)_60%,transparent)]">
      <div className="mx-auto grid grid-cols-1 max-w-[1200px] gap-10 px-6 py-14 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
        <div className="max-w-[320px]">
          <Logo size={26} />
          <p className="mt-4 text-[13.5px] leading-relaxed text-muted">Open-source product analytics and observability that runs in your own AWS account.</p>
        </div>
        {col('Project', [['Source code', REPO_URL, true], ['Report an issue', `${REPO_URL}/issues`, true], ['Sponsor', SPONSOR_URL, true], ['MIT license', repoFile('LICENSE'), true]])}
        {col('Docs', [['Installation', sectionHref('docs', 'install')], ['Configuration', sectionHref('docs', 'configuration')], ['Web SDK', sectionHref('docs', 'web')], ['OpenTelemetry guide', '#/docs/opentelemetry']])}
        {col('More', [['AI assistants (MCP)', sectionHref('docs', 'mcp')], ['Kiosk screens', sectionHref('docs', 'kiosks')], ['Cookies and privacy', sectionHref('docs', 'privacy')], ['Sign in', '#/signin']])}
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-2 px-6 py-5 text-[12.5px] text-faint">
          <span>WGO: what's going on? Free and open source under the MIT license.</span>
          <a href="#/docs" className="inline-flex items-center gap-1.5 hover:text-fg"><BookOpen size={13} />Documentation</a>
        </div>
      </div>
    </footer>
  );
}

/* Prose primitives for the docs pages. */
export const P = ({ children }: { children: ReactNode }) => <p className="text-[14.5px] leading-[1.7] text-muted">{children}</p>;
export const C = ({ children }: { children: ReactNode }) => <code className="rounded bg-[var(--hl)] px-1 py-px font-mono text-[12.5px] text-fg">{children}</code>;
export const B = ({ children }: { children: ReactNode }) => <span className="font-medium text-fg">{children}</span>;
export const Code = (p: Parameters<typeof CodeBlock>[0]) => <CodeBlock wrap={false} {...p} />;
export const Ext = ({ href, children }: { href: string; children: ReactNode }) => <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">{children}</a>;
export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2.5 text-[14.5px] leading-[1.7] text-muted">
      {items.map((t, i) => <li key={i} className="flex gap-3"><span className="mt-[11px] size-1 shrink-0 rounded-full bg-accent/70" /><span className="min-w-0">{t}</span></li>)}
    </ul>
  );
}
export function Table({ head, rows }: { head?: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-left text-[13.5px] leading-relaxed">
        {head && <thead className="bg-[var(--hl)] text-[12px] text-faint"><tr>{head.map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr></thead>}
        <tbody className="divide-y divide-[var(--line)]">
          {rows.map((r, i) => <tr key={i} className="align-top">{r.map((c, j) => <td key={j} className={cn('px-4 py-3', j === 0 ? 'whitespace-nowrap text-fg' : 'text-muted')}>{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}
export function Callout({ tone = 'accent', title, children }: { tone?: 'accent' | 'warn'; title: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-xl border px-4 py-3.5 text-[14px] leading-relaxed', tone === 'warn' ? 'border-warn/30 bg-warn/[.07]' : 'border-accent/30 bg-accent/[.07]')}>
      <p className={cn('mb-1 font-semibold', tone === 'warn' ? 'text-warn' : 'text-accent')}>{title}</p>
      <div className="text-muted">{children}</div>
    </div>
  );
}

/** Light and dark variants of a picture, following the dashboard theme rather than the OS. */
export function ThemedImg({ dark, light, alt, w, h, className }: { dark: string; light: string; alt: string; w: number; h: number; className?: string }) {
  return (
    <>
      <img src={dark} alt={alt} width={w} height={h} loading="lazy" decoding="async" className={cn('theme-dark-only h-auto w-full', className)} />
      <img src={light} alt={alt} width={w} height={h} loading="lazy" decoding="async" className={cn('theme-light-only h-auto w-full', className)} />
    </>
  );
}
