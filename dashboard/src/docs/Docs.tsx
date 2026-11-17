import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Github } from 'lucide-react';
import { cn } from '../lib/format';
import {
  B, C, Callout, Code, Ext, List, P, REPO_URL, SiteFooter, SiteHeader, Table, ThemedImg, onSectionClick, repoFile, sectionHref, useSectionScroll, useTitle,
} from '../site/Site';

/**
 * Public documentation: installing, configuring and running WGO. It follows the README, so update both together.
 * The OpenTelemetry guide has its own page (OtelDocs.tsx).
 */

const HOST = 'https://wgo.example.com';

const GROUPS: Array<{ title: string; items: Array<[id: string, label: string]> }> = [
  { title: 'Getting started', items: [['install', 'Installation'], ['first-steps', 'First steps'], ['configuration', 'Configuration'], ['updating', 'Updating and removing']] },
  { title: 'Sending data', items: [['web', 'Web apps'], ['otel', 'Backends (OpenTelemetry)']] },
  { title: 'Features', items: [['mcp', 'AI assistants (MCP)'], ['triggers', 'Filters and triggers'], ['kiosks', 'Kiosk screens'], ['android', 'Android widget'], ['teams', 'Teams and access']] },
  { title: 'Operating WGO', items: [['privacy', 'Cookies and privacy'], ['cost', 'Cost awareness'], ['architecture', 'How it works'], ['local-dev', 'Local development'], ['limits', 'Known limits']] },
];
const IDS = GROUPS.flatMap((g) => g.items.map(([id]) => id));

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} data-doc-section className="scroll-mt-24 border-t border-line pt-12 first:border-t-0 first:pt-0">
      <h2 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h2>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}
const H3 = ({ children }: { children: ReactNode }) => <h3 className="pt-3 text-[16.5px] font-semibold tracking-tight">{children}</h3>;
const Doc = ({ to, children }: { to: string; children: ReactNode }) => <a href={sectionHref('docs', to)} onClick={onSectionClick('docs', to)} className="text-accent hover:underline">{children}</a>;

/** Highlights the section being read in the sidebar. */
function useActiveSection(root: React.RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState(IDS[0]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + 120;
      let cur = IDS[0];
      for (const id of IDS) { const s = document.getElementById(id); if (s && s.getBoundingClientRect().top <= top) cur = id; }
      // the last sections are too short to reach the top of the window
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) cur = IDS[IDS.length - 1];
      setActive(cur);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [root]);
  return active;
}

export function Docs() {
  useTitle('Documentation · WGO');
  useSectionScroll();
  const scroller = useRef<HTMLDivElement>(null);
  const active = useActiveSection(scroller);

  return (
    <div ref={scroller} className="bg-atmos h-full overflow-y-auto">
      <SiteHeader />

      <div className="mx-auto grid max-w-[1200px] gap-12 px-6 pb-24 pt-14 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="hidden lg:block" aria-label="Documentation">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] space-y-6 overflow-y-auto pb-6 text-[13.5px]">
            {GROUPS.map((g) => (
              <div key={g.title}>
                <p className="mb-2 px-2.5 text-[12.5px] font-medium text-faint">{g.title}</p>
                {g.items.map(([id, label]) => (
                  <a key={id} href={sectionHref('docs', id)} onClick={onSectionClick('docs', id)}
                    className={cn('block rounded-md border-l-2 px-2.5 py-1.5 transition-colors', active === id ? 'border-accent bg-accent/10 text-fg' : 'border-transparent text-muted hover:bg-[var(--hl)] hover:text-fg')}>{label}</a>
                ))}
              </div>
            ))}
            <div className="border-t border-line pt-5">
              <a href="#/docs/opentelemetry" className="flex items-center gap-1.5 px-2.5 py-1 text-muted hover:text-fg">OpenTelemetry guide<ArrowRight size={13} /></a>
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 px-2.5 py-1 text-muted hover:text-fg"><Github size={13} />Source on GitHub</a>
            </div>
          </div>
        </nav>

        <main className="min-w-0 max-w-[800px] space-y-12">
          <div>
            <h1 className="text-[38px] font-semibold leading-tight tracking-[-0.03em]">Run WGO in your own AWS account</h1>
            <p className="mt-4 text-[16.5px] leading-relaxed text-muted">
              WGO is open-source, self-hosted product analytics and observability. This guide covers deploying it, sending it data from web apps and
              backends, and what it costs and stores. WGO runs on AWS, but the apps it monitors can run anywhere: any website, and any backend
              that sends OpenTelemetry, on any cloud or your own servers. In the examples, <C>{HOST}</C> stands for the address of your own install.
            </p>
          </div>

          {/* ───────────── Getting started ───────────── */}
          <Section id="install" title="Installation">
            <H3>Prerequisites</H3>
            <Table rows={[
              ['AWS account', 'With permission to create IAM roles, Lambda, API Gateway, Aurora DSQL, DynamoDB, Cognito, S3 and CloudFront (and Route 53 / ACM if you use a custom domain). An administrator role is the simplest.'],
              ['A supported region', <>Any region where <Ext href="https://docs.aws.amazon.com/aurora-dsql/latest/userguide/what-is-aurora-dsql.html#region-availability">Aurora DSQL is available</Ext>.</>],
              ['AWS CLI v2', <><Ext href="https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html">Installed</Ext> and configured with credentials for the account. <C>aws sts get-caller-identity</C> should work.</>],
              ['AWS SAM CLI', <><Ext href="https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html">Installed</Ext>. Docker is not needed: functions are bundled with esbuild.</>],
              ['Node.js 22+', 'With npm.'],
              ['bash', 'Linux, macOS or WSL.'],
            ]} />
            <P>Optional: a <B>domain</B> to serve WGO on, such as <C>wgo.example.com</C> (fully automatic if its hosted zone is in Route 53 in the same account), and <B>JDK 17+ with the Android SDK</B> (platform 35), only to rebuild the Android widget app.</P>

            <H3>Quick start</H3>
            <Code lang="sh" title="Terminal" code={`git clone ${REPO_URL}.git wgo && cd wgo\nnpm run setup`} />
            <P><C>npm run setup</C> is a wizard for your first deploy. You don't need <C>npm install</C> first. It asks for:</P>
            <List items={[
              'your AWS profile and region (it checks that Aurora DSQL is available there)',
              'your domain: it finds the Route 53 zone, or a matching certificate if your DNS is elsewhere',
              'which email domains can sign in, with a live check of test addresses',
              'which features to turn on',
            ]} />
            <P>It saves your answers to <C>deploy.env</C> and can start the deploy for you. Run it again whenever you want to change a setting: your current settings are the defaults, and keys it doesn't ask about are kept. To skip the wizard, copy <C>deploy.env.example</C> to <C>deploy.env</C>, edit it and run <C>npm run deploy</C>.</P>

            <H3>What the deploy does</H3>
            <ol className="list-decimal space-y-2 pl-5 text-[14.5px] leading-[1.7] text-muted marker:text-faint">
              <li>Creates a DNS-validated certificate in us-east-1, if you set a custom domain in Route 53.</li>
              <li>Installs, type-checks and unit-tests the backend, then builds and deploys it with SAM. A migration runs the database schema as part of the deploy.</li>
              <li>Builds the browser SDK, the Android app (if the toolchain is installed) and the dashboard.</li>
              <li>Uploads them to the stack's S3 bucket, invalidates CloudFront and prints your URLs.</li>
            </ol>
            <Code lang="sh" title="Output" code={`✔ WGO deployed
  Dashboard  ${HOST}
  Sign up    ${HOST}/#/signup
  API        https://….execute-api.eu-west-1.amazonaws.com
  Live       wss://….execute-api.eu-west-1.amazonaws.com/live
  SDK        ${HOST}/sdk/v1/wgo.js
  Ingest     ${HOST}      (SDK data-endpoint)
  OTLP       ${HOST}/v1/{traces,logs,metrics}   (header x-wgo-key)
  MCP        ${HOST}/mcp`} />
            <P>The first deploy takes several minutes, mostly for CloudFront. Without a custom domain, WGO is served on its <C>*.cloudfront.net</C> address.</P>
          </Section>

          <Section id="first-steps" title="First steps">
            <ol className="list-decimal space-y-3 pl-5 text-[14.5px] leading-[1.7] text-muted marker:text-faint">
              <li>Open <C>{HOST}/#/signup</C> and create your account. Cognito emails you a verification code. The homepage doesn't link to the sign-up form, so share this address with teammates too.</li>
              <li>Create a project.</li>
              <li>Copy the install snippet from the onboarding screen (or later from <B>Settings → Install</B>) into your web app, and/or set the <Doc to="otel">OpenTelemetry variables</Doc> on your services.</li>
              <li>Watch the data arrive. To try it without your own app, serve <Ext href={repoFile('examples/demo.html')}>examples/demo.html</Ext> locally and open it with <C>?key=wk_…&endpoint={HOST}&sdk={HOST}/sdk/v1/wgo.js&auto=1</C>. <C>auto=1</C> makes it click through the shop by itself.</li>
            </ol>
          </Section>

          <Section id="configuration" title="Configuration">
            <P><C>npm run setup</C> writes most of these for you. You can also set them as environment variables or in <C>deploy.env</C> (gitignored). They map to stack parameters, so you can change them later by deploying again.</P>
            <Table head={['Variable', 'Default', 'Description']} rows={[
              [<C>STACK_NAME</C>, <C>wgo</C>, 'CloudFormation stack name'],
              [<C>AWS_REGION</C>, 'CLI default', 'Region of the stack'],
              [<C>AWS_PROFILE</C>, 'CLI default', 'AWS CLI profile to deploy with'],
              [<C>CUSTOM_DOMAIN</C>, 'none', <>Serve the dashboard, SDK and ingest on your own domain, e.g. <C>wgo.example.com</C></>],
              [<C>HOSTED_ZONE_ID</C>, 'auto-detected', <>Route 53 zone of <C>CUSTOM_DOMAIN</C>, found automatically if it's in the same account</>],
              [<C>CERTIFICATE_ARN</C>, 'created for you', 'ACM certificate in us-east-1. Only needed when your DNS is not in Route 53'],
              [<C>ALLOWED_EMAIL_DOMAINS</C>, 'anyone', <>Comma-separated, e.g. <C>example.com,*.example.org</C>. Only these emails can sign up and use the dashboard</>],
              [<C>ALLOW_SELF_SIGNUP</C>, <C>true</C>, <><C>false</C>: only users you create in Cognito can sign in</>],
              [<C>DELETION_PROTECTION</C>, <C>false</C>, 'DSQL cluster deletion protection. Turn it on for production'],
              [<C>MCP_ENABLED</C>, <C>true</C>, <>The <Doc to="mcp">MCP server</Doc> at <C>/mcp</C>, with Cognito MCP auth (open client registration)</>],
              [<C>MAX_RETENTION_DAYS</C>, <C>400</C>, <>Longest raw-data retention a project owner can choose (the default is 90 days). See <Doc to="cost">Cost awareness</Doc></>],
              [<C>WRITE_BUFFER_SECONDS</C>, <C>30</C>, 'How long incoming data is collected before it is written as one Parquet file (1–300). Shorter means fresher charts, longer means fewer files. The Live page and triggers don\'t wait for it'],
              [<C>CLUSTER_METRICS_PROJECT_ID</C>, 'none', <>Project that receives hourly Aurora DSQL storage and DPU numbers, as metrics and as a <C>wgo.cluster</C> event you can create triggers on</>],
              [<C>BUILD_ANDROID</C>, <C>false</C>, <><C>true</C>: rebuild the Android app (needs JDK 17 and the Android SDK) instead of deploying the prebuilt APK</>],
              [<C>SLACK_CLIENT_ID</C>, 'none', <>With <C>SLACK_CLIENT_SECRET</C>: one Slack app for "Add to Slack" in every project's <Doc to="triggers">triggers</Doc></>],
              [<C>PARAMS</C>, 'none', <>Extra raw <C>sam deploy --parameter-overrides</C></>],
            ]} />

            <H3>Custom domain</H3>
            <List items={[
              <><B>DNS in Route 53, same account:</B> the deploy creates and DNS-validates a certificate in us-east-1 (a separate <C>{'<stack>'}-certificate</C> stack), and the main stack creates the <C>A</C>/<C>AAAA</C> records. The first run waits a few minutes for validation.</>,
              <><B>DNS elsewhere:</B> request an ACM certificate for the domain in us-east-1 yourself, set <C>CERTIFICATE_ARN</C>, deploy, then point a <C>CNAME</C> at the <C>CloudFrontDomain</C> stack output.</>,
            ]} />

            <H3>Restricting who can sign in</H3>
            <P>With <C>ALLOWED_EMAIL_DOMAINS=example.com</C>, a Cognito pre-sign-up trigger rejects other domains, and the API, WebSocket and invites enforce it too. That also covers accounts created before the allowlist was set. <C>*.example.com</C> matches subdomains. With <C>ALLOW_SELF_SIGNUP=false</C>, create users yourself; Cognito emails them a temporary password:</P>
            <Code lang="sh" title="Terminal" code="aws cognito-idp admin-create-user --user-pool-id <UserPoolId output> --username alice@example.com" />

            <H3>Email delivery</H3>
            <P>Cognito sends verification and invitation emails with its built-in sender, which has a low daily quota. For a larger team, configure the user pool to send through Amazon SES.</P>
          </Section>

          <Section id="updating" title="Updating and removing">
            <P>Pull the latest code and deploy again. Schema migrations run automatically. To ship only dashboard or SDK changes to an existing stack (no SAM, about 30 seconds), use the frontend-only deploy.</P>
            <Code lang="sh" title="Terminal" code={'git pull && npm run deploy\nnpm run deploy:frontend   # dashboard and SDK only'} />
            <P>To remove WGO, empty the web bucket and delete the stacks:</P>
            <Code lang="sh" title="Terminal" code={`aws s3 rm "s3://$(aws cloudformation describe-stacks --stack-name wgo \\
  --query "Stacks[0].Outputs[?OutputKey=='WebBucketName'].OutputValue" --output text)" --recursive
sam delete --stack-name wgo
sam delete --stack-name wgo-certificate --region us-east-1   # only if a certificate was created`} />
            <Callout tone="warn" title="Deleting the stack deletes all collected data">If <C>DELETION_PROTECTION</C> is on, deploy with it set to <C>false</C> first.</Callout>
          </Section>

          {/* ───────────── Sending data ───────────── */}
          <Section id="web" title="Web apps">
            <P>Paste the snippet from the dashboard (Settings → Install). Every click, pageview, JavaScript error, failed request and Web Vital is captured automatically:</P>
            <Code lang="html" title="index.html" code={`<script src="${HOST}/sdk/v1/wgo.js" data-write-key="wk_…" data-endpoint="${HOST}" async></script>`} />
            <List items={[
              <><C>data-track="signup-cta"</C> on an element gives its clicks a friendly name for the dashboard and live watches.</>,
              <><C>data-wgo-ignore</C> and <C>data-wgo-mask</C> exclude elements or their text.</>,
              <><C>WGO.track('event', props)</C> sends custom events, and <C>WGO.identify(userId)</C> attaches a user id. Any event can become a conversion goal and a step in a funnel.</>,
              <><C>WGO.status()</C> in the browser console shows what the SDK is doing.</>,
            ]} />
            <P>The SDK is about 10 KB gzipped. It batches events, gzips batches over 1 KB, sends errors and priority clicks within a second, and keeps events while the visitor is offline. See the <Ext href={repoFile('sdk/README.md')}>SDK README</Ext> for every option, npm usage, frameworks and tag managers.</P>
          </Section>

          <Section id="otel" title="Backends (OpenTelemetry)">
            <P>Point any OTLP/HTTP exporter at WGO with the project's write key:</P>
            <Code lang="sh" title="Environment" code={`OTEL_EXPORTER_OTLP_ENDPOINT=${HOST}\nOTEL_EXPORTER_OTLP_HEADERS=x-wgo-key=wk_…\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf   # or http/json`} />
            <List items={[
              'Traces, logs and metrics (gauge, sum, histogram, exponential histogram, summary) are accepted as protobuf or JSON, optionally gzipped. gRPC is not supported, so use the HTTP exporters.',
              <>CloudFront doesn't forward <C>Authorization</C>, so send the key in the <C>x-wgo-key</C> header.</>,
              'Requests are queued and answered right away, so exporters never wait for a cold start. Data shows up a second or two later.',
              'The write key is checked when a request is stored, so a wrong key doesn\'t produce an error response: the data is dropped and the OTLP function logs why.',
              'A request can be up to about 750 KB as sent (gzip counts).',
            ]} />
            <a href="#/docs/opentelemetry" className="glass glass-hover group flex items-center justify-between gap-4 p-5">
              <div><p className="text-[15px] font-semibold">OpenTelemetry setup guide</p><p className="mt-1 text-[13.5px] text-muted">Complete, tested examples for Node.js and Python, on servers and AWS Lambda.</p></div>
              <ArrowRight size={18} className="shrink-0 text-faint transition-transform group-hover:translate-x-1 group-hover:text-accent" />
            </a>
          </Section>

          {/* ───────────── Features ───────────── */}
          <Section id="mcp" title="AI assistants (MCP)">
            <P>WGO is a remote <Ext href="https://modelcontextprotocol.io">MCP</Ext> server. Connect Claude, VS Code, Cursor or any other MCP client and ask about traffic, errors, traces and metrics in plain language.</P>
            <Code lang="sh" title="Claude Code" code={`claude mcp add --transport http wgo ${HOST}/mcp`} />
            <P>There is no key to copy. The client registers itself, opens a browser, and you sign in with your WGO account. It then sees exactly the projects you're a member of, read-only. Use the dashboard's host (the <C>McpUrl</C> stack output): the raw API Gateway URL has no OAuth resource of its own.</P>
            <Table rows={[
              ['Product analytics', <span className="font-mono text-[12.5px]">list_projects, get_overview, top_clicks, top_pages, goal_conversions, goal_funnel, list_errors, list_failed_requests, breakdown, web_vitals, visitor_locations, search_events</span>],
              ['OpenTelemetry', <span className="font-mono text-[12.5px]">list_services, list_traces, get_trace, search_logs, list_metrics, get_metric_series</span>],
            ]} />
            <H3>How sign-in works</H3>
            <List items={[
              <><B>Discovery.</B> <C>/mcp</C> answers unauthenticated calls with a <C>401</C> pointing at its protected-resource metadata (RFC 9728), which names Cognito as the authorization server.</>,
              <><B>Registration.</B> The client registers through Cognito's open dynamic client registration.</>,
              <><B>Sign-in.</B> You sign in on Cognito managed login with PKCE.</>,
              <><B>Binding.</B> The token is bound to the MCP URL with an RFC 8707 resource indicator. The MCP function rejects tokens for any other audience, and the email allowlist applies here too.</>,
            ]} />
            <Callout tone="warn" title="Open client registration">
              Anyone who can reach the user pool can register an OAuth client and send your users to its sign-in link. That is how MCP clients connect without setup,
              but it is also a phishing surface. Set <C>MCP_ENABLED=false</C> if you don't need MCP, and consider an AWS WAF rate-based rule on <C>/oauth2/register</C>.
            </Callout>
          </Section>

          <Section id="triggers" title="Filters and triggers">
            <P>Every analytics page, plus Logs and Traces, has a filter bar. Filter on any field, event property (<C>props.plan</C>) or OpenTelemetry attribute (<C>attributes.http.route</C>, <C>resource.service.version</C>). Operators include equals, contains, begins with, ends with, numeric comparisons, is set and is not set. Filters live in the URL, so a filtered view is a shareable link. Expand any event or log line to see all its attributes, and click one to filter by it.</P>
            <P><B>Triggers</B> notify you when new events match a filter. Create one from the current filters (<B>Create trigger</B> in the filter bar), from any event, or on the Triggers page.</P>
            <List items={[
              <><B>Slack:</B> click <B>Add to Slack</B> and pick the workspace and channel. A self-hosted WGO needs its own Slack app, created once: the Triggers page walks a project owner through it in about a minute. To set it up for every project at once, put <C>SLACK_CLIENT_ID</C> and <C>SLACK_CLIENT_SECRET</C> in <C>deploy.env</C>.</>,
              <><B>Webhooks:</B> an HTTPS POST of JSON with <C>trigger</C>, <C>project</C>, <C>matches</C>, <C>events</C> and <C>url</C>, signed with <C>X-WGO-Signature: sha256=…</C> (an HMAC-SHA256 of the body with the trigger's signing secret). Private and internal addresses are refused.</>,
              <><B>Cooldown:</B> at most one notification per period you choose. Matches in between are counted and reported with the next one. <B>Test</B> sends a sample notification immediately.</>,
            ]} />
          </Section>

          <Section id="kiosks" title="Kiosk screens">
            <P>Turn a Raspberry Pi and a TV into a wall display for a project. Create a kiosk on the <B>Kiosks</B> page and run the one command it shows on the Pi:</P>
            <Code lang="sh" title="On the Pi" code={`curl -fsSL ${HOST}/downloads/wgo-kiosk.sh | sudo bash -s -- '${HOST}/#/kiosk/ks_…'`} />
            <P>The Pi boots straight into the dashboard, full screen, and you control it from WGO without touching the Pi again.</P>
            <List items={[
              <><B>Choose what it shows.</B> Pick one or more pages, each with its own time range, filters and caption. With several pages, the screen switches between them on a timer. Or set up any page as you want it and click <B>Show on kiosk</B>.</>,
              <><B>Changes show up within 15 seconds.</B> Theme, zoom and refresh rate are set remotely too, and <B>Reload</B> reloads the page on the screen.</>,
              <><B>No sign-in on the screen.</B> The kiosk URL holds a long random token with read access to that project's analytics and nothing else. Replace it if it leaks.</>,
              <><B>Unattended.</B> It waits for the network at boot, keeps showing the last data while offline, keeps the display awake and fits every page to the screen.</>,
            ]} />
            <P>The script works on Raspberry Pi OS Bookworm or newer, Lite or Desktop, on a Pi 3, 4, 5 or Zero 2 W. It runs Chromium in <Ext href="https://github.com/cage-kiosk/cage">cage</Ext> as an unprivileged user. On the Pi, <C>sudo wgo-kiosk --status</C> shows whether it's running and <C>sudo wgo-kiosk --uninstall</C> removes it. Any other screen works too: open the kiosk link full screen in a browser.</P>
          </Section>

          <Section id="android" title="Android widget">
            <P>Keep the numbers you care about on your home screen. Pick a project, a time range and up to eight stats: visitors right now, errors, failed API calls, Web Vitals, backend latency, tracked clicks or any OpenTelemetry metric.</P>
            <List items={[
              'Resize it from a single number at 2×1 up to a chart with a grid of tiles at 4×3.',
              'Connect a phone by scanning a QR code in the dashboard (the Widget page, which also has the download). It gets a read-only key that you can revoke at any time.',
              'It refreshes in the background every 15 to 180 minutes, or immediately when you tap refresh.',
            ]} />
            <P>The deploy ships a prebuilt APK. To build it yourself, see the <Ext href={repoFile('android/README.md')}>Android README</Ext>.</P>
          </Section>

          <Section id="teams" title="Teams and access">
            <P>Accounts use Cognito with email sign-up. Projects have owners and members. An owner invites people by email on the project's Settings page, and they get access the next time they sign in with that address. New users create their account at <C>{HOST}/#/signup</C>.</P>
            <P>Limit sign-ups to your company's email domains with <C>ALLOWED_EMAIL_DOMAINS</C>, or turn off self sign-up completely with <C>ALLOW_SELF_SIGNUP=false</C>. See <Doc to="configuration">Configuration</Doc>.</P>
          </Section>

          {/* ───────────── Operating ───────────── */}
          <Section id="privacy" title="Cookies and privacy">
            <P><B>WGO sets no cookies</B>, neither on your visitors nor in the dashboard. CloudFront doesn't forward cookies to the backend either, so cookies your own site sets on the same domain never reach WGO.</P>
            <H3>What the SDK stores in the browser</H3>
            <Table head={['Key', 'Contents', 'Kept until']} rows={[
              [<C>wgo:aid</C>, 'A random anonymous visitor id, so returning visitors are counted once', 'The visitor clears site data'],
              [<C>wgo:sid</C>, 'Session id, time of last activity, and whether this session is sampled', 'Replaced after 30 minutes of inactivity'],
              [<C>wgo:uid</C>, <>The user id you pass to <C>WGO.identify()</C>, or one read from your app's JWT</>, <><C>WGO.reset()</C>. Only set if you identify users</>],
              [<C>wgo:q:…</C>, 'Events that haven\'t been sent yet, e.g. while offline', <>They are delivered. Turn off with <C>persist: false</C></>],
            ]} />
            <H3>Cookieless mode</H3>
            <P>Add <C>data-cookieless</C> to the script tag (or <C>cookieless: true</C> with npm) and the SDK keeps everything in memory, writing nothing to <C>localStorage</C>, <C>sessionStorage</C> or cookies. The trade-off: every page load is a new visitor and session, so counts go up and multi-page funnels break at each full page load. Single-page apps keep one session while the tab stays open.</P>
            <H3>What is collected</H3>
            <P>With each event: the anonymous id, the session id, the page URL and referrer (query strings stripped unless <C>captureQueryParams</C> is on), browser, OS and device type, language, screen size, time zone and a city-level location from CloudFront. <B>IP addresses are never stored.</B> For clicks, the SDK records the element's selector and a short label. It never records what someone typed, and records no label for fields that look like passwords, secrets, tokens or card numbers.</P>
            <Callout title="Consent">
              Under EU and UK rules, storing an identifier in <C>localStorage</C> is treated the same as setting a cookie, so "no cookies" doesn't mean you can skip consent.
              If you need consent first, load the SDK from your consent callback. <C>data-respect-do-not-track</C> turns the SDK off for browsers that send Do Not Track.
              See the <Ext href={`${REPO_URL}#cookies-and-privacy`}>README</Ext> for withdrawing consent and identifying users.
            </Callout>
          </Section>

          <Section id="cost" title="Cost awareness">
            <P>Everything is billed per request and per GB, so an idle install costs close to nothing and the bill follows your traffic. Raw telemetry is stored as compressed Parquet in S3 and queried by DuckDB inside the API Lambda. Aurora DSQL only holds projects, settings, error stacks and hourly aggregates. As traffic grows, cost comes from four places:</P>
            <List items={[
              <><B>Stored data.</B> Raw data is kept for each project's retention (90 days by default), as ZSTD-compressed Parquet, usually a tenth of the raw size or less. <C>MAX_RETENTION_DAYS</C> caps what owners can choose.</>,
              <><B>Ingest.</B> Data is written as one Parquet file per project and day every <C>WRITE_BUFFER_SECONDS</C>, so it costs a few Lambda invocations and S3 PUTs per minute. OpenTelemetry logs and spans are usually the largest share: filter or sample them in your collector. The SDK's <C>sampleRate</C> keeps a fraction of sessions on busy sites.</>,
              <><B>Dashboard queries.</B> A query reads the files of the days in range, so cost grows with traffic times range length. Unfiltered Overview charts over 3 days or more read hourly aggregates instead. A tab left open on a long, filtered range with auto-refresh is the most expensive way to use WGO.</>,
              <><B>Background work.</B> A maintenance Lambda runs every 15 minutes to merge small files, build hourly aggregates and delete expired days.</>,
            ]} />
            <P><B>Watch the bill.</B> Set <C>CLUSTER_METRICS_PROJECT_ID</C> and that project receives the cluster's storage and DPU usage every hour, as metrics and as a <C>wgo.cluster</C> event. A trigger on <C>props.storageGb {'>'} 5</C> can post to Slack when the database grows. For a hard monthly limit, also set up an <Ext href="https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html">AWS Budget</Ext>.</P>
          </Section>

          <Section id="architecture" title="How it works">
            <div className="glass overflow-hidden p-3 sm:p-5">
              <ThemedImg dark="home/architecture-dark.svg" light="home/architecture-light.svg" w={1530} h={770}
                alt="WGO architecture: web apps and OpenTelemetry services send data through CloudFront to API Gateway, which queues it in SQS; Lambdas write Parquet to S3; a maintenance Lambda compacts it and rolls it up into Aurora DSQL; the dashboard, widget, kiosks and MCP clients query it through Lambdas running DuckDB, and get live events over a WebSocket API" />
            </div>
            <List items={[
              <><B>Ingest.</B> API Gateway writes SDK batches and OTLP requests straight to SQS, with no Lambda in the request path. Lambdas behind the queue write each batch to S3 as Parquet and, in parallel, push matching events to live watches over a WebSocket.</>,
              <><B>Raw data.</B> Events, spans, logs and metric points live in the <C>DataBucket</C> as <C>{'{table}/project_id={id}/dt={YYYY-MM-DD}/*.parquet'}</C>. The API runs an in-process DuckDB and reads only the project's files for the days in range. You can point DuckDB, Athena or Spark at the bucket yourself.</>,
              <><B>Configuration.</B> Aurora DSQL is serverless and PostgreSQL-compatible, so you can query it with <C>psql</C> and IAM auth. It holds projects, members, goals, triggers, kiosks, error stacks and the hourly rollups.</>,
              <><B>Maintenance.</B> Every 15 minutes a Lambda compacts small files, builds hourly rollups (with HyperLogLog sketches for sessions and users) and applies retention.</>,
              <><B>Location.</B> CloudFront looks up each viewer's city at the edge and forwards it in headers. The backend never sees IP addresses, and coordinates are rounded to about 11 km.</>,
            ]} />
          </Section>

          <Section id="local-dev" title="Local development">
            <Code lang="sh" title="Terminal" code={`# Postgres stands in for DSQL locally; raw data goes to Parquet files in backend/.wgo-store
docker run -d --rm --name wgo-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine

cd sdk && npm i && npm run build && cd ..
cd backend && npm i
DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npm run dev
# → prints a write key and http://localhost:8787/examples/demo.html?key=wk_…
npm run seed -- --key wk_…     # optional: 24h of realistic SDK + OTel traffic

cd dashboard && npm i
npm run dev:local              # the real dashboard against the local backend
npm run dev:mock               # …or against an in-browser mock (no backend needed)`} />
            <P>The local server runs the real Lambda handlers. It skips Cognito, so every API call acts as one dev user, and it skips the WebSocket fan-out, so the Live page only works when deployed or under <C>dev:mock</C>. Tests run with <C>npm test</C> in <C>sdk/</C> and <C>backend/</C>, and <C>npm run test:integration</C> in <C>backend/</C> runs the full API against Postgres and Parquet.</P>
          </Section>

          <Section id="limits" title="Known limits">
            <List items={[
              'Only the Overview\'s KPIs, events chart, top pages and breakdowns have rollups. Filtered views and other pages aggregate raw rows, so they reach back only as far as the project\'s retention.',
              <>Charts and lists trail live traffic by up to <C>WRITE_BUFFER_SECONDS</C> plus a few seconds. The Live page and triggers aren't delayed.</>,
              'Raw data is append-only: there is no way to edit or delete single events short of rewriting that day\'s files. Deleting whole days, through retention, is cheap.',
              'Events that arrive more than about an hour late (offline SDK batches) are missing from the rollups; raw-backed views still show them.',
              <>Cumulative OTLP sums are stored as reported. Chart them with <C>max</C> or <C>avg</C> rather than <C>sum</C>.</>,
              'The Lambdas connect to DSQL as admin. For least privilege, create a custom database role for the function roles.',
            ]} />
            <P>The full list is in the <Ext href={`${REPO_URL}#known-limits`}>README</Ext>. Found something else? <Ext href={`${REPO_URL}/issues`}>Open an issue</Ext>.</P>
          </Section>
        </main>
      </div>

      <SiteFooter />
    </div>
  );
}
