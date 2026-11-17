import type { ReactNode } from 'react';
import {
  ArrowRight, BellRing, BookOpen, Bot, Check, Cloud, Cookie, Gauge, Github, Heart, Layers, Package, Rocket, LogIn, Scale, ShieldCheck,
  Target, Terminal, Tv, Users, Wrench, Activity, Lock, Code2, Globe, Server,
} from 'lucide-react';
import { CodeBlock } from '../ui/CodeBlock';
import { cn } from '../lib/format';
import { REPO_URL, SPONSOR_URL, SiteFooter, SiteHeader, ThemedImg, onSectionClick, sectionHref, useSectionScroll, useTitle } from '../site/Site';

/** Screenshots in public/home/, taken from the mock dashboard (npm run dev:mock). Relative so a sub-path deploy works. */
const shot = (file: string) => `home/${file}`;
/** Example host in snippets: this page presents the project, so it shows where your own install will live. */
const HOST = 'https://wgo.example.com';

function Shot({ src, alt, w, h, eager }: { src: string; alt: string; w: number; h: number; eager?: boolean }) {
  return (
    <img src={shot(src)} alt={alt} width={w} height={h} loading={eager ? 'eager' : 'lazy'} decoding="async"
      className="h-auto w-full rounded-xl border border-[var(--line-strong)] shadow-[0_30px_80px_-30px_rgba(0,0,0,.8)]" />
  );
}

/**
 * The feature film (video/ in the repo, rendered with HyperFrames). Silent, so it can autoplay muted and loop;
 * it stays on its poster for visitors who ask for reduced motion, and has controls because it runs 1:49.
 */
function FeatureVideo() {
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <video ref={(v) => { if (v) v.muted = true; }} src={shot('wgo-features.mp4')} poster={shot('wgo-features-poster.jpg')}
      width={1920} height={1080} autoPlay={!still} muted loop playsInline controls preload={still ? 'none' : 'auto'}
      aria-label="A tour of WGO: a click on a web shop shows up on the live map, then the Overview, Live, Goals, Errors, Triggers, Traces, Logs, Metrics, an AI assistant over MCP, the Android widget and a Raspberry Pi kiosk on an office TV"
      className="h-auto w-full rounded-xl border border-[var(--line-strong)] bg-black shadow-[0_30px_80px_-30px_rgba(0,0,0,.8)]" />
  );
}

function H2({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('text-[30px] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[36px]', className)}>{children}</h2>;
}

function Points({ items, first }: { items: ReactNode[]; first?: boolean }) {
  return (
    <ul className={cn(first ? 'mt-6 lg:mt-0' : 'mt-6', 'space-y-3 text-[14.5px] leading-relaxed text-muted')}>
      {items.map((t, i) => <li key={i} className="flex gap-3"><Check size={15} className="mt-[3px] shrink-0 text-accent" />{t}</li>)}
    </ul>
  );
}

function Feature({ id, title, intro, points, extra, media, flip, wide }: {
  id: string; title: string; intro: ReactNode; points: ReactNode[]; extra?: ReactNode; media: ReactNode; flip?: boolean;
  /** Text above a full-width screenshot, for dashboard pages that are unreadable at half width. */
  wide?: boolean;
}) {
  const heading = (
    <>
      <h3 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">{title}</h3>
      <p className="mt-4 text-[15.5px] leading-relaxed text-muted">{intro}</p>
    </>
  );
  if (wide) {
    return (
      <section id={id} className="scroll-mt-20 py-20">
        <div className="grid gap-x-16 gap-y-2 lg:grid-cols-2">
          <div>{heading}</div>
          <div className="lg:pt-1"><Points items={points} first />{extra && <div className="mt-7">{extra}</div>}</div>
        </div>
        <div className="mt-12">{media}</div>
      </section>
    );
  }
  return (
    <section id={id} className="grid scroll-mt-20 items-center gap-10 py-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
      <div className={cn(flip && 'lg:order-2')}>
        {heading}
        <Points items={points} />
        {extra && <div className="mt-7">{extra}</div>}
      </div>
      <div className={cn('min-w-0', flip && 'lg:order-1')}>{media}</div>
    </section>
  );
}

/** Example MCP conversation. There is no UI to screenshot, so it's drawn here with the real tool names. */
function McpExample() {
  const calls = [['list_errors', 'range: "24h"'], ['list_failed_requests', 'range: "24h"'], ['list_traces', 'service: "payment-service", errors: true']];
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--raised)] shadow-[0_30px_80px_-30px_rgba(0,0,0,.8)]">
      <div className="border-b border-line px-5 py-3 text-[12.5px] text-faint">Example conversation in an MCP client</div>
      <div className="space-y-5 p-5 text-[14px] leading-relaxed">
        <div className="ml-auto max-w-[85%] rounded-xl bg-[var(--hl)] px-4 py-3">Checkout complaints started this afternoon. What's going on?</div>
        <div className="space-y-1.5 font-mono text-[12px] text-faint">
          {calls.map(([n, a]) => <div key={n} className="flex items-center gap-2"><Wrench size={12} className="shrink-0" /><span className="text-muted">wgo.{n}</span><span className="truncate">{a}</span></div>)}
        </div>
        <div className="flex gap-3">
          <Bot size={18} className="mt-0.5 shrink-0 text-faint" />
          <div className="space-y-3 text-fg/90">
            <p>Failed calls to <code className="font-mono text-[13px]">POST /api/checkout</code> went from a handful an hour to 41 since 14:00, almost all 502s. The matching traces in payment-service spend 8–10 s waiting on the card processor before timing out.</p>
            <p>The browser side follows from that: most new JavaScript errors are a TypeError on /checkout, thrown when the response body is empty.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A terminal running the first deploy. The output is what scripts/deploy.sh prints. */
function DeployTerminal() {
  const lines: Array<[ReactNode, string?]> = [
    [<><span className="text-[#22d3ee]">$</span> git clone {REPO_URL.replace('https://', '')} wgo</>],
    [<><span className="text-[#22d3ee]">$</span> cd wgo && npm run setup</>],
    [<span className="text-[#7d7c8c]">◇ AWS account · region eu-west-1 (Aurora DSQL ✓)</span>],
    [<span className="text-[#7d7c8c]">◇ Web address · wgo.example.com</span>],
    [<span className="text-[#7d7c8c]">◇ Who can sign in · @example.com</span>],
    [<span className="text-[#7d7c8c]">◇ Deploying wgo to eu-west-1…</span>],
    [''],
    [<span className="font-semibold text-[#34d399]">✔ WGO deployed</span>],
    [<><span className="text-[#7d7c8c]">  Dashboard </span> {HOST}</>],
    [<><span className="text-[#7d7c8c]">  SDK       </span> {HOST}/sdk/v1/wgo.js</>],
    [<><span className="text-[#7d7c8c]">  OTLP      </span> {HOST}/v1/{'{traces,logs,metrics}'}</>],
    [<><span className="text-[#7d7c8c]">  MCP       </span> {HOST}/mcp</>],
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-white/15 bg-[#0b0b11] shadow-[0_40px_100px_-30px_rgba(0,0,0,.85)]">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <i className="size-3 rounded-full bg-[#ff5f57]/80" /><i className="size-3 rounded-full bg-[#febc2e]/80" /><i className="size-3 rounded-full bg-[#28c840]/80" />
        <span className="ml-3 font-mono text-[11.5px] text-[#7d7c8c]">~/wgo</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-[1.75] text-[#ecebe8]">
        {lines.map(([l], i) => <div key={i} className="term-line whitespace-pre" style={{ animationDelay: `${150 + i * 140}ms` }}>{l || ' '}</div>)}
        <div className="term-line" style={{ animationDelay: `${150 + lines.length * 140}ms` }}><span className="text-[#22d3ee]">$</span> <span className="term-caret inline-block h-[14px] w-[7px] translate-y-[2px] bg-[#ecebe8]/70" /></div>
      </pre>
    </div>
  );
}

const HIGHLIGHTS: Array<{ icon: ReactNode; title: string; body: string }> = [
  { icon: <ShieldCheck size={18} />, title: 'Your data stays yours', body: 'Everything runs in your AWS account. Nothing is sent to a third party, IP addresses are never stored and no cookies are set.' },
  { icon: <Cloud size={18} />, title: 'Serverless, scales to zero', body: 'Lambda, S3, Aurora DSQL and CloudFront. No servers or databases to patch, and an idle install costs close to nothing.' },
  { icon: <Rocket size={18} />, title: 'One command to deploy', body: 'A setup wizard creates the stack, builds the dashboard and SDK, uploads them and prints your URLs.' },
  { icon: <Scale size={18} />, title: 'MIT licensed', body: 'Read every line, change what you need and run it for as many projects and users as you like.' },
];

const MORE: Array<{ icon: ReactNode; title: string; body: string; doc: string }> = [
  { icon: <Tv size={18} />, title: 'Kiosk screens', body: 'Turn a Raspberry Pi and a TV into a wall display. Pick pages, time ranges and rotation from the dashboard.', doc: 'kiosks' },
  { icon: <BellRing size={18} />, title: 'Filters and triggers', body: 'Filter any page on any property or OpenTelemetry attribute, and get a Slack message or webhook when new events match.', doc: 'triggers' },
  { icon: <Target size={18} />, title: 'Goals and funnels', body: 'Turn a click, a pageview or a custom event into a conversion and see where people drop off.', doc: 'web' },
  { icon: <Users size={18} />, title: 'Teams and access', body: 'Projects with owners and members, email invites, and sign-up limited to your company domains.', doc: 'teams' },
  { icon: <Cookie size={18} />, title: 'Cookieless mode', body: 'One attribute makes the SDK store nothing on the visitor\'s device at all, not even in localStorage.', doc: 'privacy' },
  { icon: <Package size={18} />, title: 'A 10 KB SDK', body: 'Batched, gzipped and kept while offline. Errors and important clicks are sent within a second.', doc: 'web' },
];

const SOURCES: Array<{ icon: ReactNode; title: string; body: string; chips: string[] }> = [
  { icon: <Globe size={18} />, title: 'Any website or web app', body: 'The browser SDK is one script tag or an npm package. If you can add HTML to a page, WGO can see it.',
    chips: ['React', 'Next.js', 'Vue', 'Svelte', 'Angular', 'Plain HTML', 'WordPress', 'Tag managers'] },
  { icon: <Code2 size={18} />, title: 'Any language', body: 'Backends send traces, logs and metrics with their standard OpenTelemetry SDK, or through an OpenTelemetry Collector.',
    chips: ['Node.js', 'Python', 'Go', 'Java', '.NET', 'Ruby', 'PHP', 'Rust'] },
  { icon: <Server size={18} />, title: 'Any host', body: 'Your apps don\'t need to be on AWS. Everything reaches WGO over HTTPS, from any cloud, data center or laptop.',
    chips: ['Kubernetes', 'Docker', 'VMs', 'Bare metal', 'Google Cloud', 'Azure', 'Vercel', 'AWS Lambda'] },
];

const STACK = ['AWS Lambda', 'API Gateway', 'SQS', 'Parquet files on S3', 'DuckDB', 'Aurora DSQL', 'DynamoDB', 'Cognito', 'CloudFront'];

const PREREQS: Array<[string, string]> = [
  ['An AWS account', 'With permission to create IAM roles, Lambda, API Gateway, Aurora DSQL, DynamoDB, Cognito, S3 and CloudFront.'],
  ['A supported region', 'Any region where Aurora DSQL is available. The wizard checks it for you.'],
  ['AWS CLI v2 and SAM CLI', 'Configured with credentials for the account. Docker is not needed.'],
  ['Node.js 22+ and bash', 'On Linux, macOS or WSL.'],
];

function Step({ n, title, children, last }: { n: number; title: string; children: ReactNode; last?: boolean }) {
  return (
    <li className="relative grid grid-cols-[36px_minmax(0,1fr)] gap-x-5">
      {!last && <span className="absolute bottom-0 left-[17px] top-10 w-px bg-gradient-to-b from-[var(--line-strong)] to-transparent" />}
      <span className="grad-bg grid size-9 place-items-center rounded-full font-mono text-[13px] font-semibold text-white shadow-[0_6px_20px_-6px_rgba(124,108,240,.7)]">{n}</span>
      <div className={cn('min-w-0 pt-1.5', !last && 'pb-10')}>
        <h3 className="text-[17px] font-semibold tracking-tight">{title}</h3>
        <div className="mt-3 space-y-4 text-[14.5px] leading-relaxed text-muted">{children}</div>
      </div>
    </li>
  );
}
const C = ({ children }: { children: ReactNode }) => <code className="rounded bg-[var(--hl)] px-1 py-px font-mono text-[12.5px] text-fg">{children}</code>;

const DOCS: Array<{ icon: ReactNode; title: string; body: string; href: string }> = [
  { icon: <Rocket size={17} />, title: 'Installation', body: 'Prerequisites, the setup wizard and your first project.', href: sectionHref('docs', 'install') },
  { icon: <Layers size={17} />, title: 'Configuration', body: 'Custom domains, who can sign in, retention and Slack.', href: sectionHref('docs', 'configuration') },
  { icon: <Code2 size={17} />, title: 'Web SDK', body: 'The script tag, named clicks, custom events and user ids.', href: sectionHref('docs', 'web') },
  { icon: <Activity size={17} />, title: 'OpenTelemetry guide', body: 'Node.js and Python, on servers and AWS Lambda.', href: '#/docs/opentelemetry' },
  { icon: <Bot size={17} />, title: 'AI assistants (MCP)', body: 'Connect Claude, VS Code or Cursor. No API keys.', href: sectionHref('docs', 'mcp') },
  { icon: <Tv size={17} />, title: 'Kiosk screens', body: 'Your dashboard on a TV with a Raspberry Pi.', href: sectionHref('docs', 'kiosks') },
  { icon: <Lock size={17} />, title: 'Cookies and privacy', body: 'What the SDK stores and collects, and consent.', href: sectionHref('docs', 'privacy') },
  { icon: <Gauge size={17} />, title: 'Cost awareness', body: 'Where the bill comes from as your traffic grows.', href: sectionHref('docs', 'cost') },
];

export function Landing() {
  useTitle('WGO · Open-source analytics and observability for AWS');
  useSectionScroll();

  const ctas = (
    <div className="flex flex-wrap gap-3">
      <a href={sectionHref('', 'install')} onClick={onSectionClick('', 'install')}
        className="grad-bg inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-[14px] font-medium text-white shadow-[0_8px_28px_-8px_rgba(124,108,240,.8)] transition-all hover:brightness-110 active:scale-[.98]">
        <Terminal size={16} />Deploy your own
      </a>
      <a href={REPO_URL} target="_blank" rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-line bg-[var(--hl)] px-5 py-2.5 text-[14px] font-medium transition-all hover:border-[var(--line-strong)] hover:bg-[var(--line)] active:scale-[.98]">
        <Github size={16} />View on GitHub
      </a>
    </div>
  );

  return (
    <div className="bg-atmos h-full overflow-y-auto overflow-x-hidden">
      <SiteHeader />

      <main id="top" className="mx-auto max-w-[1200px] px-6">
        {/* Hero */}
        <section className="relative isolate pb-10 pt-16 lg:pt-24">
          <div className="hero-glow" />
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            <div>
              <h1 className="text-[42px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[56px]">
                See what's going on in your web app and the services behind it
              </h1>
              <p className="mt-6 max-w-[580px] text-[17px] leading-relaxed text-muted">
                WGO is open-source product analytics and observability that you deploy into your own AWS account with one command.
                It runs on AWS but monitors anything: one script tag records clicks, pageviews, errors and Web Vitals on any website,
                and backends in any language, on any cloud, send traces, logs and metrics over OpenTelemetry.
              </p>
              <div className="mt-9">{ctas}</div>
              <p className="mt-5 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-faint">
                {['Any stack, any cloud', 'No cookies', 'No IP addresses stored'].map((t) => <span key={t} className="inline-flex items-center gap-1.5"><Check size={13} className="text-good" />{t}</span>)}
              </p>
            </div>
            <div className="min-w-0"><DeployTerminal /></div>
          </div>

          <div className="relative mt-20">
            <div className="absolute -inset-x-10 -inset-y-6 -z-10 rounded-[40px] bg-[radial-gradient(60%_60%_at_50%_40%,var(--glow1),transparent_70%)] blur-2xl" />
            <FeatureVideo />
          </div>
        </section>

        {/* Monitors anything */}
        <section id="anything" className="scroll-mt-16 pt-16">
          <div className="mx-auto max-w-[720px] text-center">
            <H2>Runs on AWS. Watches everything else.</H2>
            <p className="mt-5 text-[16px] leading-relaxed text-muted">
              AWS is only where WGO itself lives. What it monitors can run anywhere: any website that can load a script tag, and any backend
              that speaks OpenTelemetry, whatever the language, framework or host.
            </p>
          </div>
          <div className="mt-12 grid gap-4 lg:grid-cols-3">
            {SOURCES.map((c) => (
              <div key={c.title} className="glass p-6">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl border border-accent2/25 bg-accent2/10 text-accent2">{c.icon}</span>
                  <h3 className="text-[15.5px] font-semibold tracking-tight">{c.title}</h3>
                </div>
                <p className="mt-4 text-[13.5px] leading-relaxed text-muted">{c.body}</p>
                <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-faint">{c.chips.join(', ')}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Highlights */}
        <section className="grid gap-4 py-16 sm:grid-cols-2 lg:grid-cols-4">
          {HIGHLIGHTS.map((h) => (
            <div key={h.title} className="glass glass-hover p-6">
              <span className="grid size-10 place-items-center rounded-xl border border-accent/25 bg-accent/10 text-accent">{h.icon}</span>
              <h3 className="mt-5 text-[15.5px] font-semibold tracking-tight">{h.title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{h.body}</p>
            </div>
          ))}
        </section>

        {/* Features */}
        <div id="features" className="scroll-mt-16 pt-12">
          <div className="mx-auto max-w-[720px] text-center">
            <H2>Web analytics and backend telemetry in one dashboard</H2>
            <p className="mt-5 text-[16px] leading-relaxed text-muted">Everything shows up in the same project and updates as it happens, so you can follow a problem from a click in the browser to the slow span behind it.</p>
          </div>
          <div className="divide-y divide-[var(--line)]">
            <Feature id="analytics" title="Every click, pageview and error, within seconds" wide
              intro="Add one script tag and WGO records every click, pageview, JavaScript error, failed API call and Web Vital without any extra code."
              points={[
                'Watch a button, page or error and see each hit arrive, with an optional toast or browser notification.',
                'A live map shows where visitors are, to the nearest city. Locations come from CloudFront, and IP addresses are never stored.',
                'The browser SDK is about 10 KB gzipped. It batches and compresses events, and holds on to them while the visitor is offline.',
              ]}
              media={<Shot src="live.jpg" alt="The Live page: click counters for the signup button, add to cart and checkout, and a world map with recent events at each location" w={2416} h={2000} />} />

            <Feature id="otel" title="Metrics, traces and logs from your backends" wide
              intro="Point any OpenTelemetry SDK or Collector at WGO with three environment variables, wherever your services run. Your backend telemetry sits next to your web analytics, in the same project."
              points={[
                'Gauges, sums, histograms, exponential histograms and summaries. Chart the average, sum, min, max or p95, and split a series by any attribute.',
                'Each trace opens as a span waterfall. Logs can be filtered by severity, service and text, and link to their trace.',
                'OTLP over HTTP, as protobuf or JSON, gzipped or not.',
              ]}
              extra={<>
                <CodeBlock lang="sh" title="Environment" code={`OTEL_EXPORTER_OTLP_ENDPOINT=${HOST}\nOTEL_EXPORTER_OTLP_HEADERS=x-wgo-key=wk_…\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`} />
                <a href="#/docs/opentelemetry" className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-accent hover:underline">Setup guide for Node.js and Python, on servers and AWS Lambda<ArrowRight size={14} /></a>
              </>}
              media={<Shot src="metrics.jpg" alt="The Metrics page: a list of OpenTelemetry metrics such as http.server.request.duration, with a chart of the selected metric over 24 hours" w={2416} h={1220} />} />

            <Feature id="mcp" title="Ask your AI assistant with MCP" flip
              intro="Connect Claude, VS Code or any other MCP client to WGO and ask about traffic, errors, traces and metrics in plain language. The assistant looks up the numbers itself, so you don't have to paste screenshots into the chat."
              points={[
                'You sign in with your WGO account in the browser. There is no API key to copy.',
                'Access is read-only and limited to the projects you are a member of.',
                'Eighteen tools cover the overview, top pages and clicks, conversion goals, errors, failed requests, Web Vitals, visitor locations, traces, logs and metrics.',
              ]}
              extra={<CodeBlock lang="sh" title="Claude Code" code={`claude mcp add --transport http wgo ${HOST}/mcp`} />}
              media={<McpExample />} />

            <Feature id="android" title="A home-screen widget for your phone"
              intro="Keep the numbers you care about on your phone. Pick a project, a time range and up to eight stats: visitors right now, errors, failed API calls, Web Vitals, backend latency, your tracked clicks or any OpenTelemetry metric."
              points={[
                'Resize it from a single number at 2×1 up to a chart with a grid of tiles at 4×3.',
                'Connect the phone by scanning a QR code in the dashboard. It gets a read-only key that you can revoke at any time.',
                'It refreshes in the background every 15 to 180 minutes, or immediately when you tap refresh.',
              ]}
              media={<div className="mx-auto w-full max-w-[340px]"><img src={shot('widget.png')} alt="The WGO widget on an Android home screen, showing pageviews with a chart and tiles for sessions, JavaScript errors, clicks and failed API calls" width={640} height={1360} loading="lazy" decoding="async" className="h-auto w-full drop-shadow-[0_30px_60px_rgba(0,0,0,.6)]" /></div>} />
          </div>

          <div className="border-t border-line py-20">
            <h3 className="text-center text-[22px] font-semibold tracking-tight">And a lot more</h3>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MORE.map((m) => (
                <a key={m.title} href={sectionHref('docs', m.doc)} className="glass glass-hover group block p-6">
                  <span className="text-accent2">{m.icon}</span>
                  <h4 className="mt-4 flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">{m.title}<ArrowRight size={14} className="text-faint opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" /></h4>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{m.body}</p>
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* Self-hosting */}
        <section id="install" className="scroll-mt-16 border-t border-line py-24">
          <div className="max-w-[720px]">
            <H2>Deploy it into your own AWS account</H2>
            <p className="mt-5 text-[16px] leading-relaxed text-muted">
              A setup wizard asks a handful of questions and runs the deploy. The first one takes several minutes, mostly for CloudFront.
              After that you own the whole thing: the stack, the data and the bill.
            </p>
          </div>

          <div className="mt-14 grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
            <aside className="lg:sticky lg:top-24 lg:self-start">
              <div className="glass p-6">
                <h3 className="text-[15px] font-semibold">What you need</h3>
                <ul className="mt-5 space-y-4">
                  {PREREQS.map(([t, d]) => (
                    <li key={t} className="flex gap-3">
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-good/15 text-good"><Check size={12} strokeWidth={3} /></span>
                      <div><p className="text-[14px] font-medium">{t}</p><p className="mt-0.5 text-[13px] leading-relaxed text-muted">{d}</p></div>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 border-t border-line pt-5 text-[13px] leading-relaxed text-muted">
                  <p><span className="text-fg">Optional:</span> a domain, fully automatic when its hosted zone is in Route 53. Without one, WGO is served on its CloudFront address.</p>
                </div>
              </div>
              <a href={sectionHref('docs', 'install')} className="mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium text-accent hover:underline"><BookOpen size={15} />Full installation guide<ArrowRight size={14} /></a>
            </aside>

            <ol>
              <Step n={1} title="Clone the repository and run the setup wizard">
                <CodeBlock lang="sh" title="Terminal" wrap={false} code={`git clone ${REPO_URL}.git wgo && cd wgo\nnpm run setup`} />
                <p>
                  The wizard asks for your AWS profile and region, your domain, which email domains can sign in and which features to turn on.
                  It saves the answers to <C>deploy.env</C> and starts the deploy. Run it again whenever you want to change a setting.
                </p>
              </Step>
              <Step n={2} title="Let the deploy do the rest">
                <p>
                  It installs and tests the backend, deploys it with AWS SAM, builds the browser SDK and the dashboard, uploads them and prints your URLs.
                  To deploy without the wizard, copy <C>deploy.env.example</C> to <C>deploy.env</C>, edit it and run <C>npm run deploy</C>.
                </p>
              </Step>
              <Step n={3} title="Create your account and a project">
                <p>
                  Open <C>{HOST}/#/signup</C>, sign up with your email address and enter the code Cognito sends you. Then create your first project.
                  Teammates sign up at the same address, and you add them to a project from its Settings page.
                </p>
              </Step>
              <Step n={4} title="Send it some data" last>
                <p>Paste the snippet from the dashboard into your web app. Clicks, pageviews, errors, failed requests and Web Vitals are captured automatically:</p>
                <CodeBlock lang="html" title="index.html" code={`<script src="${HOST}/sdk/v1/wgo.js" data-write-key="wk_…" data-endpoint="${HOST}" async></script>`} />
                <p>For your backends, set the three OpenTelemetry variables shown above on each service.</p>
              </Step>
            </ol>
          </div>

          <div className="mt-16 grid gap-4 md:grid-cols-2">
            <div className="glass p-6">
              <h3 className="text-[15px] font-semibold">Updating</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">Pull the latest code and deploy again. Schema migrations run automatically.</p>
              <div className="mt-4"><CodeBlock lang="sh" title="Terminal" wrap={false} code={'git pull && npm run deploy\nnpm run deploy:frontend   # dashboard and SDK only, about 30 s'} /></div>
            </div>
            <div className="glass p-6">
              <h3 className="text-[15px] font-semibold">Trying it locally</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">Run the dashboard against an in-browser mock with demo data, no AWS account needed. Sign in with any email and password.</p>
              <div className="mt-4"><CodeBlock lang="sh" title="Terminal" wrap={false} code={'cd dashboard && npm install\nnpm run dev:mock'} /></div>
            </div>
          </div>
        </section>

        {/* Architecture */}
        <section id="architecture" className="scroll-mt-16 border-t border-line py-24">
          <div className="grid gap-x-16 gap-y-6 lg:grid-cols-2">
            <div>
              <H2>Serverless from the script tag to the chart</H2>
            </div>
            <p className="text-[15.5px] leading-relaxed text-muted lg:pt-1">
              Data is queued as soon as it arrives, so pages and exporters never wait for a cold start. Lambdas write it to S3 as Parquet,
              and queries run DuckDB inside the API Lambda against only the files they need. Long ranges read hourly rollups from Aurora DSQL.
            </p>
          </div>
          <div className="glass mt-12 overflow-hidden p-4 sm:p-8">
            <ThemedImg dark={shot('architecture-dark.svg')} light={shot('architecture-light.svg')} w={1530} h={770}
              alt="WGO architecture: web apps and OpenTelemetry services send data through CloudFront to API Gateway, which queues it in SQS; Lambdas process it and write Parquet to S3; a maintenance Lambda compacts it and rolls it up into Aurora DSQL; the dashboard, widget, kiosks and MCP clients query it through Lambdas running DuckDB, and get live events over a WebSocket API" />
          </div>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {[
              ['Ingest never waits', 'API Gateway writes SDK batches and OTLP requests straight to SQS. There is no Lambda in the request path.'],
              ['Raw data in Parquet', 'Events, spans, logs and metric points are ZSTD-compressed Parquet in your S3 bucket. Point Athena or Spark at it too.'],
              ['Rollups for long ranges', 'A maintenance job merges small files, builds hourly aggregates and deletes data past each project\'s retention.'],
            ].map(([t, d]) => (
              <div key={t} className="border-l-2 border-accent/40 pl-5">
                <h3 className="text-[15px] font-semibold">{t}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
          <p className="mt-12 text-[13.5px] leading-relaxed text-muted">WGO itself is built on {STACK.slice(0, -1).join(', ')} and {STACK[STACK.length - 1]}.</p>
        </section>

        {/* Documentation */}
        <section id="docs" className="scroll-mt-16 border-t border-line py-24">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-[620px]">
              <H2>Everything you need to run it</H2>
            </div>
            <a href="#/docs" className="inline-flex items-center gap-1.5 text-[14px] font-medium text-accent hover:underline">Browse all docs<ArrowRight size={14} /></a>
          </div>
          <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {DOCS.map((d) => (
              <a key={d.title} href={d.href} className="glass glass-hover group flex flex-col p-5">
                <span className="grid size-9 place-items-center rounded-lg bg-[var(--hl)] text-muted transition-colors group-hover:text-accent">{d.icon}</span>
                <h3 className="mt-4 text-[14.5px] font-semibold">{d.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{d.body}</p>
              </a>
            ))}
          </div>
        </section>

        {/* Closing call to action */}
        <section className="pb-24">
          <div className="relative isolate overflow-hidden rounded-3xl border border-[var(--line-strong)] px-8 py-16 text-center sm:px-16">
            <div className="absolute inset-0 -z-10 bg-[radial-gradient(70%_120%_at_20%_0%,var(--glow1),transparent_60%),radial-gradient(60%_120%_at_90%_100%,var(--glow2),transparent_60%)]" />
            <h2 className="mx-auto max-w-[680px] text-[32px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]">Your analytics, in your account</h2>
            <p className="mx-auto mt-5 max-w-[560px] text-[16px] leading-relaxed text-muted">
              WGO is free and built in spare time. If it saves you a hosted analytics bill, consider sponsoring it. Stars, bug reports and telling others help too.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              {ctas}
              <a href={SPONSOR_URL} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-[14px] font-medium text-muted transition-colors hover:bg-[var(--hl)] hover:text-fg">
                <Heart size={16} className="text-[#db61a2]" />Sponsor
              </a>
            </div>
          </div>
          <p className="mt-8 flex items-center justify-center gap-2 text-[13px] text-faint"><LogIn size={14} />Already have an account on this server? <a href="#/signin" className="text-accent hover:underline">Sign in</a></p>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
