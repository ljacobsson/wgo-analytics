import type { ReactNode } from 'react';

/** Everything the browser SDK can be configured with from a script tag (see sdk/src/auto.ts and sdk/README.md). */
export interface SdkOptions {
  capture: Record<CaptureKind, boolean>;
  cookieless: boolean;
  autoIdentify: boolean;
  respectDoNotTrack: boolean;
  captureQueryParams: boolean;
  persist: boolean;
  compress: boolean;
  debug: boolean;
  /** percent of sessions, 0–100 */
  samplePercent: number;
  sessionTimeoutMinutes: number;
  release: string;
  environment: string;
  /** comma-separated URL substrings */
  httpIgnore: string;
  /** one CSS selector list */
  priorityClicks: string;
}

export type CaptureKind = 'pageviews' | 'clicks' | 'errors' | 'http' | 'vitals';
const KINDS: Array<{ kind: CaptureKind; label: string }> = [
  { kind: 'pageviews', label: 'Pageviews' },
  { kind: 'clicks', label: 'Clicks' },
  { kind: 'errors', label: 'JavaScript errors' },
  { kind: 'http', label: 'Failed requests' },
  { kind: 'vitals', label: 'Web vitals' },
];

export const DEFAULT_OPTIONS: SdkOptions = {
  capture: { pageviews: true, clicks: true, errors: true, http: true, vitals: true },
  cookieless: false,
  autoIdentify: false,
  respectDoNotTrack: false,
  captureQueryParams: false,
  persist: true,
  compress: true,
  debug: false,
  samplePercent: 100,
  sessionTimeoutMinutes: 30,
  release: '',
  environment: '',
  httpIgnore: '',
  priorityClicks: '',
};

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const valid = (n: number, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max;

/** The options that differ from the SDK defaults, in SDK terms. */
function changes(o: SdkOptions) {
  const off = KINDS.filter((k) => !o.capture[k.kind]).map((k) => k.kind);
  return {
    autocaptureOn: off.length ? KINDS.filter((k) => o.capture[k.kind]).map((k) => k.kind) : null,
    autocaptureOff: off,
    cookieless: o.cookieless,
    autoIdentify: o.autoIdentify,
    respectDoNotTrack: o.respectDoNotTrack,
    captureQueryParams: o.captureQueryParams,
    persist: !o.cookieless && !o.persist ? false : null, // cookieless already turns it off
    compress: o.compress ? null : false,
    debug: o.debug,
    sampleRate: valid(o.samplePercent, 0, 100) && o.samplePercent !== 100 ? Math.round(o.samplePercent * 1000) / 100000 : null,
    sessionTimeout: valid(o.sessionTimeoutMinutes, 1, 1440) && o.sessionTimeoutMinutes !== 30 ? Math.round(o.sessionTimeoutMinutes * 60_000) : null,
    release: o.release.trim(),
    environment: o.environment.trim(),
    httpIgnore: list(o.httpIgnore),
    priorityClicks: o.priorityClicks.trim(),
  };
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const js = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function scriptSnippet(o: SdkOptions, sdkUrl: string, writeKey: string, endpoint: string): string {
  const c = changes(o);
  const extra: string[] = [];
  if (c.autocaptureOn) extra.push(`data-autocapture="${c.autocaptureOn.join(',')}"`);
  if (c.cookieless) extra.push('data-cookieless');
  if (c.autoIdentify) extra.push('data-auto-identify');
  if (c.respectDoNotTrack) extra.push('data-respect-do-not-track');
  if (c.captureQueryParams) extra.push('data-capture-query-params');
  if (c.sampleRate !== null) extra.push(`data-sample-rate="${c.sampleRate}"`);
  if (c.sessionTimeout !== null) extra.push(`data-session-timeout="${c.sessionTimeout}"`);
  if (c.release) extra.push(`data-release="${attr(c.release)}"`);
  if (c.environment) extra.push(`data-environment="${attr(c.environment)}"`);
  if (c.httpIgnore.length) extra.push(`data-http-ignore="${attr(c.httpIgnore.join(','))}"`);
  if (c.priorityClicks) extra.push(`data-priority-clicks="${attr(c.priorityClicks)}"`);
  if (c.persist === false) extra.push('data-persist="false"');
  if (c.compress === false) extra.push('data-compress="false"');
  if (c.debug) extra.push('data-debug');
  const base = [`src="${sdkUrl}"`, `data-write-key="${writeKey}"`, `data-endpoint="${endpoint}"`];
  if (!extra.length) return `<script ${base.join(' ')} async></script>`;
  return `<script ${[...base, ...extra, 'async'].join('\n        ')}></script>`;
}

export function npmSnippet(o: SdkOptions, writeKey: string, endpoint: string): string {
  const c = changes(o);
  const lines = [`writeKey: ${js(writeKey)},`, `endpoint: ${js(endpoint)},`];
  if (c.autocaptureOff.length) lines.push(`autocapture: { ${c.autocaptureOff.map((k) => `${k}: false`).join(', ')} },`);
  if (c.cookieless) lines.push('cookieless: true,');
  if (c.autoIdentify) lines.push('autoIdentify: true,');
  if (c.respectDoNotTrack) lines.push('respectDoNotTrack: true,');
  if (c.captureQueryParams) lines.push('captureQueryParams: true,');
  if (c.sampleRate !== null) lines.push(`sampleRate: ${c.sampleRate},`);
  if (c.sessionTimeout !== null) lines.push(`sessionTimeout: ${c.sessionTimeout}, // ${o.sessionTimeoutMinutes} min`);
  if (c.release) lines.push(`release: ${js(c.release)},`);
  if (c.environment) lines.push(`environment: ${js(c.environment)},`);
  if (c.httpIgnore.length) lines.push(`httpIgnore: [${c.httpIgnore.map(js).join(', ')}],`);
  if (c.priorityClicks) lines.push(`priorityClicks: [${js(c.priorityClicks)}],`);
  if (c.persist === false) lines.push('persist: false,');
  if (c.compress === false) lines.push('compress: false,');
  if (c.debug) lines.push('debug: true,');
  return `import { init } from 'wgo-sdk';\n\ninit({\n${lines.map((l) => `  ${l}`).join('\n')}\n});`;
}

function Check({ checked, onChange, disabled, children, hint }: { checked: boolean; onChange: (b: boolean) => void; disabled?: boolean; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className={`flex items-start gap-2 text-[12.5px] ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="checkbox" className="mt-[3px] accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}{hint && <span className="block text-[11.5px] text-faint">{hint}</span>}</span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</legend>
      {children}
    </fieldset>
  );
}

function Text({ label, value, onChange, placeholder, hint, type = 'text', suffix }: { label: string; value: string | number; onChange: (v: string) => void; placeholder?: string; hint?: string; type?: 'text' | 'number'; suffix?: string }) {
  return (
    <label className="block min-w-0 text-[12.5px]">
      <span className="mb-1 block">{label}</span>
      <span className="flex items-center gap-2">
        <input className="field min-w-0 flex-1" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} {...(type === 'number' ? { min: 0, step: 'any' } : {})} />
        {suffix && <span className="text-[12px] text-muted">{suffix}</span>}
      </span>
      {hint && <span className="mt-1 block text-[11.5px] text-faint">{hint}</span>}
    </label>
  );
}

export function SnippetOptionsPanel({ value: o, onChange }: { value: SdkOptions; onChange: (o: SdkOptions) => void }) {
  const set = <K extends keyof SdkOptions>(k: K, v: SdkOptions[K]) => onChange({ ...o, [k]: v });
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
      <Group title="Capture automatically">
        {KINDS.map((k) => (
          <Check key={k.kind} checked={o.capture[k.kind]} onChange={(b) => set('capture', { ...o.capture, [k.kind]: b })}>{k.label}</Check>
        ))}
      </Group>
      <Group title="Privacy">
        <Check checked={o.cookieless} onChange={(b) => set('cookieless', b)} hint="Nothing in localStorage or cookies. Every page load counts as a new visitor and session.">Cookieless: store nothing on the device</Check>
        <Check checked={o.autoIdentify} onChange={(b) => set('autoIdentify', b)} hint="Reads the email or username from your app's JWT. Email addresses are personal data.">Identify logged-in users from your app's login token</Check>
        <Check checked={o.respectDoNotTrack} onChange={(b) => set('respectDoNotTrack', b)} hint="Turns the SDK off for browsers that send Do Not Track.">Respect Do Not Track</Check>
        <Check checked={o.captureQueryParams} onChange={(b) => set('captureQueryParams', b)} hint="Off by default: query strings often carry tokens or personal data.">Keep query strings in URLs</Check>
      </Group>
      <Group title="Delivery">
        <Check checked={o.persist && !o.cookieless} disabled={o.cookieless} onChange={(b) => set('persist', b)} hint={o.cookieless ? 'Not available in cookieless mode.' : 'Unsent events wait in localStorage, e.g. while offline.'}>Keep unsent events across page loads</Check>
        <Check checked={o.compress} onChange={(b) => set('compress', b)} hint="gzip for batches over 1 KB.">Compress large batches</Check>
        <Check checked={o.debug} onChange={(b) => set('debug', b)} hint="Logs every send to the browser console.">Debug logging</Check>
      </Group>
      <Group title="Sessions and labels">
        <div className="grid grid-cols-2 gap-3">
          <Text label="Sessions recorded" type="number" suffix="%" value={o.samplePercent} onChange={(v) => set('samplePercent', Number(v))} />
          <Text label="Session timeout" type="number" suffix="min" value={o.sessionTimeoutMinutes} onChange={(v) => set('sessionTimeoutMinutes', Number(v))} />
          <Text label="Release" value={o.release} placeholder="1.4.2" onChange={(v) => set('release', v)} />
          <Text label="Environment" value={o.environment} placeholder="production" onChange={(v) => set('environment', v)} />
        </div>
      </Group>
      <div className="grid grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-2">
        <Text label="Never report requests to" value={o.httpIgnore} placeholder="/health, ads.example.com" hint="Comma-separated parts of URLs." onChange={(v) => set('httpIgnore', v)} />
        <Text label="Priority clicks" value={o.priorityClicks} placeholder="button.buy, #signup" hint="CSS selectors. These clicks are sent within a second, for Live watches." onChange={(v) => set('priorityClicks', v)} />
      </div>
    </div>
  );
}
