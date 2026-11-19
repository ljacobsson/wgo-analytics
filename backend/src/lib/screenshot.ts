import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import type { Shooter } from './sites';
import { isPublicHost } from './triggers';

/**
 * Homepage screenshots with headless Chromium, for ScreenshotFunction only. puppeteer-core and @sparticuz/chromium
 * come from the Chromium layer (layers/chromium), loaded with require so they resolve through NODE_PATH like
 * DuckDB does; the small interfaces below are the parts of their API used here.
 *
 * Every request the page makes (the page itself, redirects, scripts, images) is checked first: only http(s) to
 * hosts whose name and every resolved address are public, so a site can't point the browser at the Lambda's own
 * localhost services.
 */
interface Chromium { args: string[]; executablePath(): Promise<string>; setGraphicsMode: boolean }
interface Req {
  url(): string;
  resourceType(): string;
  isInterceptResolutionHandled(): boolean;
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}
interface Res { status(): number; headers(): Record<string, string>; content?(): Promise<Uint8Array>; buffer?(): Promise<Uint8Array> }
interface Page {
  setRequestInterception(on: boolean): Promise<void>;
  setUserAgent(ua: string): Promise<void>;
  on(event: 'request', fn: (r: Req) => void): void;
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<Res | null>;
  screenshot(opts: { type: 'jpeg'; quality: number }): Promise<Uint8Array>;
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}
interface Browser { newPage(): Promise<Page>; userAgent(): Promise<string>; close(): Promise<void> }
interface Puppeteer {
  launch(opts: Record<string, unknown>): Promise<Browser>;
  defaultArgs(opts: { args: string[]; headless: 'shell' }): Promise<string[]> | string[];
}

const WIDTH = 1280, HEIGHT = 800;
/** 1280×800 CSS pixels saved as 800×500: sharp enough for a card background, about 40 KB as JPEG. */
const SCALE = 0.625;
const NAV_TIMEOUT_MS = 20_000;
const SETTLE_MS = 2_000;
const ICON_TIMEOUT_MS = 8_000;
const MAX_ICON_BYTES = 64 * 1024;
const ICON_TYPES = new Set(['image/png', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * The page's icons, best first: SVG (or sizes="any"), then apple-touch-icon (180 px, opaque), then the largest
 * declared size; /favicon.ico last. Runs in the page, so it's plain JavaScript in a string: a function would be
 * compiled by esbuild/tsx, which can add helpers (__name) that don't exist in the page.
 */
const ICON_CANDIDATES = `(() => {
  const links = [...document.querySelectorAll('link[rel][href]')]
    .filter((l) => /(^|\\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\\s|$)/i.test(l.rel));
  const score = (l) => {
    const sizes = (l.getAttribute('sizes') || '').toLowerCase();
    if (sizes === 'any' || /svg/i.test(l.type) || /\\.svg($|\\?)/i.test(l.href)) return 1000;
    const max = Math.max(0, ...[...sizes.matchAll(/(\\d+)x\\d+/g)].map((m) => Number(m[1])));
    return /apple-touch/i.test(l.rel) ? 500 + (max || 180) : max || 16;
  };
  const hrefs = links.sort((a, b) => score(b) - score(a)).map((l) => l.href);
  return [...new Set([...hrefs, new URL('/favicon.ico', location.href).href])].slice(0, 4);
})()`;

/** A data URL for an icon of an allowed image type and size, else null. */
export function iconDataUrl(type: string | undefined, bytes: Uint8Array): string | null {
  const t = (type ?? '').split(';')[0].trim().toLowerCase();
  if (!ICON_TYPES.has(t) || !bytes.byteLength || bytes.byteLength > MAX_ICON_BYTES) return null;
  return `data:${t};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Whether a resolved address is public (isPublicHost wants a dotted name, so IPv6 is checked here). */
export function isPublicIp(address: string): boolean {
  const v = isIP(address);
  if (v === 4) return isPublicHost(address);
  if (v !== 6) return false;
  const a = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPublicHost(mapped[1]);
  // unspecified, loopback, unique local (fc00::/7), link-local (fe80::/10), other mapped/compat forms
  return !(a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('::ffff:') || /^::\d/.test(a));
}

async function publicAddress(host: string, cache: Map<string, Promise<boolean>>): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return isPublicIp(bare);
  if (!isPublicHost(host)) return false;
  let p = cache.get(host);
  if (!p) {
    p = lookup(host, { all: true }).then((as) => as.length > 0 && as.every((a) => isPublicIp(a.address)), () => false);
    cache.set(host, p);
  }
  return p;
}

export async function openBrowser(): Promise<{ shoot: Shooter; close: () => Promise<void> }> {
  const req = typeof require === 'function' ? require : createRequire(import.meta.url);
  const chromium = req('@sparticuz/chromium') as { default?: Chromium } & Chromium;
  const cr = chromium.default ?? chromium;
  const pptr = req('puppeteer-core') as { default?: Puppeteer } & Puppeteer;
  const puppeteer = pptr.default ?? pptr;
  cr.setGraphicsMode = false;
  const browser = await puppeteer.launch({
    args: await puppeteer.defaultArgs({ args: cr.args, headless: 'shell' }),
    executablePath: await cr.executablePath(),
    headless: 'shell',
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, isMobile: false, hasTouch: false, isLandscape: true },
  });
  // a regular Chrome user agent: some sites turn "HeadlessChrome" away
  const ua = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');

  const shoot: Shooter = async (origin) => {
    const page = await browser.newPage();
    const dns = new Map<string, Promise<boolean>>();
    try {
      await page.setUserAgent(ua);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        void (async () => {
          if (req.isInterceptResolutionHandled()) return;
          let ok = false;
          try {
            const u = new URL(req.url());
            if (u.protocol === 'data:' || u.protocol === 'blob:') ok = true;
            else ok = (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && req.resourceType() !== 'media' && await publicAddress(u.hostname, dns);
          } catch {
            ok = false;
          }
          await (ok ? req.continue() : req.abort('blockedbyclient')).catch(() => undefined);
        })();
      });
      const res = await page.goto(origin + '/', { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      if (!res) throw new Error('no response');
      if (res.status() < 200 || res.status() >= 300) throw new Error(`the homepage answered ${res.status()}`);
      if (!/text\/html|xhtml/i.test(res.headers()['content-type'] ?? '')) throw new Error('the homepage is not an HTML page');
      // late fonts, images and entrance animations
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const image = await page.screenshot({ type: 'jpeg', quality: 60 });
      // the icon: opened in the same page, so it passes the same address checks; the first usable one wins
      let icon: string | null = null;
      for (const href of await page.evaluate<string[]>(ICON_CANDIDATES).catch(() => [] as string[])) {
        try {
          if (href.startsWith('data:')) {
            const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(href);
            if (m) icon = iconDataUrl(m[1], m[2] ? Buffer.from(m[3], 'base64') : new TextEncoder().encode(decodeURIComponent(m[3])));
          } else {
            const r = await page.goto(href, { waitUntil: 'load', timeout: ICON_TIMEOUT_MS });
            if (r && r.status() >= 200 && r.status() < 300) {
              const bytes = r.content ? await r.content() : r.buffer ? await r.buffer() : null;
              if (bytes) icon = iconDataUrl(r.headers()['content-type'], bytes);
            }
          }
        } catch { /* try the next one */ }
        if (icon) break;
      }
      return { image, icon };
    } finally {
      await page.close().catch(() => undefined);
    }
  };
  return { shoot, close: () => browser.close() };
}
