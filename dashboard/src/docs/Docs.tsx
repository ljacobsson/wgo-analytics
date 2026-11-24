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
  { title: 'Sending data', items: [['web', 'Web apps'], ['sourcemaps', 'Source maps'], ['otel', 'Backends (OpenTelemetry)'], ['trace-linking', 'Browser requests and traces']] },
  { title: 'Features', items: [['retention', 'Retention and cohorts'], ['mcp', 'AI assistants (MCP)'], ['triggers', 'Filters and triggers'], ['suppress', 'Suppressing errors'], ['releases', 'Releases and deploys'], ['why', 'Why did this change?'], ['uptime', 'Uptime checks'], ['costs', 'What the install costs'], ['kiosks', 'Kiosk screens'], ['android', 'Android widget'], ['teams', 'Teams and access']] },
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

      <div className="mx-auto grid grid-cols-1 max-w-[1200px] gap-12 px-6 pb-24 pt-14 lg:grid-cols-[220px_minmax(0,1fr)]">
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
              <li>Open <C>{HOST}/#/signup</C> and create your account. Cognito emails you a verification code. The front page is the sign-in screen, and it links to sign-up while self sign-up is on.</li>
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
              [<C>UPDATE_CHECK</C>, <C>true</C>, <>The dashboard checks GitHub every few hours and shows a dismissable note with the update command when <C>main</C> has commits newer than your install. The request goes from the signed-in user's browser to <C>api.github.com</C>. <C>false</C> turns it off</>],
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
            <P>The SDK is about 11 KB gzipped. It batches events, gzips batches over 1 KB, sends errors and priority clicks within a second, and keeps events while the visitor is offline. See the <Ext href={repoFile('sdk/README.md')}>SDK README</Ext> for every option, npm usage, frameworks and tag managers.</P>
            <H3>Frustration signals and heatmaps</H3>
            <P>The Clicks page has a Frustration tab and a Heatmap tab. <B>Rage clicks</B> are three or more clicks on one element within a second. A <B>dead click</B> is a click on a link, button, <C>role="button"</C> or submit control after which the page did nothing for a second: no DOM change and no URL change. Links that open a new tab, download or start an email or call are not counted. An <B>error click</B> is a click followed by a JavaScript error or failed request in the same session within two seconds. Each row links to recorded sessions where it happened, opened at the click.</P>
            <P>The heatmap shows where visitors click on one page, for desktop or for mobile (phones and tablets), using clicks made at the most common window width. When session recording is on, it is drawn over a snapshot of the page from a recorded visit; without recordings it is drawn on a blank page.</P>
          </Section>

          <Section id="sourcemaps" title="Source maps">
            <P>Minified production code makes error stacks hard to read. Upload your source maps and WGO shows the original file, line and function in the Errors page, with a few lines of code around each frame. A <B>Show minified</B> button brings back the raw stack.</P>
            <List items={[
              <>Build with hidden source maps: <C>build: {'{ sourcemap: \'hidden\' }'}</C> in Vite, <C>devtool: 'hidden-source-map'</C> in webpack. The bundles then have no <C>sourceMappingURL</C> comment.</>,
              <>Set the same <C>release</C> in <C>wgo.init</C> and when uploading, so each deploy is matched with its own maps. Maps uploaded without a release are the fallback.</>,
              <>Copy the upload key from <B>Settings → Source maps</B> (owners only). It is a secret for your CI, unlike the write key.</>,
            ]} />
            <Code lang="sh" title="after your build" code={`npx wgo-sourcemaps --endpoint ${HOST} --key uk_… --release 1.4.0 dist/`} />
            <P>The command uploads every <C>*.js.map</C> under the folder. It also reads <C>WGO_ENDPOINT</C>, <C>WGO_UPLOAD_KEY</C> and <C>WGO_RELEASE</C>, and exits with an error if an upload fails. Don't deploy the <C>.map</C> files to your site: they contain your source code. Maps are kept for 400 days, and stacks are mapped when you read them, so a map uploaded later also fixes older errors.</P>
            <P>When a stack has no maps, the Errors and Events pages say <B>Source maps missing</B>. The quickest one-off fix is your AI assistant: with WGO's <Doc to="mcp">MCP server</Doc> connected, ask Claude Code in the app's repository to build it with source maps and upload them. Its <C>upload_sourcemaps</C> tool hands out upload links that work for 10 minutes, so no key is involved, and any project member can use it. Use the command above in CI to cover every deploy.</P>
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

          <Section id="trace-linking" title="Browser requests and backend traces">
            <P>When a web app and its backend send data to the same project, a failed request in the browser links to the backend trace it started, and the trace links back to the visitor's session and recording.</P>
            <List items={[
              <>The SDK adds a W3C <C>traceparent</C> header to the page's own requests (fetch and XHR). Any OpenTelemetry-instrumented backend continues that trace, so its spans share the trace id.</>,
              <>A failed request is reported with that trace id. On the trace page, the browser request is the root span, with the page, the visitor and links to the replay at that moment.</>,
              <>Only same-origin requests get the header by default, because a custom header on a cross-origin request triggers a CORS preflight. For an API on another host, list it in <C>data-trace-origins="https://api.example.com/"</C> and allow <C>traceparent</C> in its <C>Access-Control-Allow-Headers</C>.</>,
              <>The header marks the request as sampled, so a backend using OpenTelemetry's default parent-based sampler records every request the browser starts.</>,
              <>A request that already carries a <C>traceparent</C> keeps it. Turn the header off with <C>data-trace-propagation="false"</C>.</>,
            ]} />
          </Section>

          {/* ───────────── Features ───────────── */}
          <Section id="retention" title="Retention and cohorts">
            <P>The Retention page groups visitors by the day, week or month they started (their first visit, or the first time they reached a goal) and shows the share of each group that came back in the periods after. Split by device, country or source to see which visitors stick.</P>
            <List items={[
              <>Retention is built each night from the previous day's visits into a small table with one row per visitor and day. It is kept for 400 days, much longer than raw events (<C>retention_days</C>), so cohorts can reach back a year.</>,
              'The first numbers show up after the first full day. The page says how far back the data goes; people first seen before that count as new on the first day.',
              'A visitor is the user id when the browser has identified, else the anonymous id. Bots are left out. Days, weeks (starting Monday) and months are UTC.',
              <>The page uses the time range at the top when it is 8 weeks or longer (up to 400 days), otherwise the last 12 weeks. At most 30 days, 26 weeks or 13 months of cohorts are shown. The API is <C>GET /api/projects/&#123;id&#125;/retention</C> and the MCP tool is <C>get_retention</C>.</>,
            ]} />
          </Section>

          <Section id="mcp" title="AI assistants (MCP)">
            <P>WGO is a remote <Ext href="https://modelcontextprotocol.io">MCP</Ext> server. Connect Claude, VS Code, Cursor or any other MCP client and ask about traffic, errors, traces and metrics in plain language.</P>
            <Code lang="sh" title="Claude Code" code={`claude mcp add --transport http wgo ${HOST}/mcp`} />
            <P>There is no key to copy. The client registers itself, opens a browser, and you sign in with your WGO account. It then sees exactly the projects you're a member of, read-only. Use the dashboard's host (the <C>McpUrl</C> stack output): the raw API Gateway URL has no OAuth resource of its own.</P>
            <Table rows={[
              ['Product analytics', <span className="font-mono text-[12.5px]">list_projects, get_overview, top_clicks, top_pages, goal_conversions, goal_funnel, get_retention, list_frustration, list_errors, list_failed_requests, explain_change, list_releases, breakdown, web_vitals, visitor_locations, search_events, find_recordings, list_uptime_checks</span>],
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
              <><B>Slack:</B> click <B>Slack channel</B>, connect your workspace once (Slack asks which one), then pick channels from a list, as many as you like. Private channels show up once you <C>/invite @WGO</C> there. A workspace is connected for the project (any member adds its channels) or for yourself (your own channels, in all your projects). A self-hosted WGO needs its own Slack app, created once: the Triggers page walks you through it in about a minute. One app works for every project. Save it for yourself to use it in all your projects, or, as a project owner, for everyone in the project. To set it up for everyone at once, put <C>SLACK_CLIENT_ID</C> and <C>SLACK_CLIENT_SECRET</C> in <C>deploy.env</C>. The app needs the bot token scopes <C>chat:write</C>, <C>chat:write.public</C>, <C>channels:read</C> and <C>groups:read</C>; an app created before WGO used a bot needs them added under <B>OAuth &amp; Permissions</B>.</>,
              <><B>Slack message:</B> when a trigger posts to Slack, <B>Design message</B> lays out its message: add, reorder and edit blocks (header, text, fields, the list of matches, small print, divider, buttons, image), with a preview filled with sample data. Text can include variables such as <C>{'{{trigger.name}}'}</C>, <C>{'{{summary}}'}</C>, <C>{'{{matches_list}}'}</C>, <C>{'{{url}}'}</C> or a field of the latest match (<C>{'{{event.path}}'}</C>, <C>{'{{log.body}}'}</C>, <C>{'{{span.attributes.http.route}}'}</C>). The JSON tab takes Block Kit from Slack's Block Kit Builder. If Slack rejects a design, WGO sends its default message instead and the trigger's status says why.</>,
              <><B>Webhooks:</B> an HTTPS POST of JSON with <C>trigger</C>, <C>project</C>, <C>matches</C>, <C>events</C> and <C>url</C>, signed with <C>X-WGO-Signature: sha256=…</C> (an HMAC-SHA256 of the body with the saved webhook's signing secret, or the trigger's for a one-off URL). Private and internal addresses are refused.</>,
              <><B>Destinations:</B> save Slack channels and webhooks once under <B>Destinations</B> on the Triggers page and pick them in any trigger. <B>This project</B>'s are shared with its members. <B>Yours</B> are your own: you can use them in every project you're a member of, and only you can change them. Other members see their name, and they stop receiving a project's notifications when you leave it.</>,
              <><B>Cooldown:</B> at most one notification per period you choose. Matches in between are counted and reported with the next one. <B>Test</B> sends a sample notification immediately.</>,
            ]} />
            <P>Besides firing on each match, a trigger can watch a number over a window of 5 minutes to 24 hours, checked every minute: a count, sessions, the share of sessions, or the average, p75 or p95 of a field.</P>
            <List items={[
              <><B>Crosses a value:</B> "fewer than 1 pageview in 30 minutes" (the site or the snippet is broken), "p95 of server spans above 1 second", "more than 5% of sessions hit an error".</>,
              <><B>Is unusual:</B> compared with the same window on each of the last 7 days, so a quiet night doesn't look like an outage. It needs 3 days of history.</>,
              <>You get one message when it starts firing and one when it's back to normal. For event counts, the firing message says what the change comes from, as on the Overview's <B>Why?</B>.</>,
              <>The dialog shows the current value while you set it up, so you can see whether it would fire right now.</>,
            ]} />
          </Section>

          <Section id="suppress" title="Suppressing errors">
            <P>Noise like a missing product image or a browser extension's errors can be suppressed. Open an error and click <B>Suppress errors like this</B>, or manage the rules under <B>Suppressed errors</B> on the Errors page.</P>
            <List items={[
              <>A rule matches on the error's <B>kind</B> (error, rejection, resource, manual), its <B>failing URL</B> (the resource that didn't load or the script that threw), its <B>message</B> and the <B>page</B>. Every field you set must match.</>,
              <>Patterns use <C>*</C> as a wildcard, match the whole value and ignore case: <C>https://cdn.example.com/img/*</C>, <C>TypeError: *</C>, <C>*ResizeObserver loop*</C>, <C>/admin/*</C>. A URL pattern that is just a path, like <C>/img/*</C>, matches any host.</>,
              <>Matching errors are dropped when they arrive: they aren't stored, counted, shown live or sent to triggers. Each rule counts what it dropped.</>,
              <>Errors stored before the rule are left out of the Overview and hidden on the Errors page (<B>Show</B> brings them back). Hourly totals for longer ranges are recounted within a few minutes. Deleting a rule brings the stored ones back.</>,
            ]} />
          </Section>

          <Section id="releases" title="Releases and deploys">
            <P>Tell WGO which version is running and every version is compared with the one before it: the share of sessions with an error or a failed request, Web Vitals, conversion per goal, and error groups that first appeared in that release. Backend versions get error rate and latency.</P>
            <List items={[
              <>Web: <C>data-release="1.4.2"</C> on the script tag, or <C>release</C> in <C>WGO.init</C>. Backends: <C>OTEL_RESOURCE_ATTRIBUTES=service.version=1.4.2</C>.</>,
              <>A version is marked worse or better only when the difference is clearly beyond noise (95% intervals that don't overlap, or a 10% change in a p75 with enough samples).</>,
              <>The time each version was first seen is kept for good, and shows as a marker on the Overview's chart and the Releases page.</>,
            ]} />
          </Section>

          <Section id="why" title="Why did this change?">
            <P>When a number on the Overview moves more than chance would explain, it gets a <B>Why?</B> link. WGO compares the selected range with the one before it and says:</P>
            <List items={[
              <><B>What accounts for it:</B> the page, browser, OS, device, country, release, error message or failing request that changed more than everything else did. A segment that only grew in line with the total isn't reported, however big it is.</>,
              <><B>When it started,</B> if the change began at a clear point in the range.</>,
              <><B>Which release</B> went out just before, if one did.</>,
            ]} />
            <P>Goal conversion works the same way, by entry page, source, device, browser, country and release. AI assistants get it as the <C>explain_change</C> tool, and threshold triggers include it in their notifications.</P>
          </Section>

          <Section id="uptime" title="Uptime checks">
            <P>Add a URL on the <B>Uptime</B> page and WGO fetches it every 1, 5 or 15 minutes, from the AWS region where WGO is deployed. Each check shows its state, a bar per time slice and the response time. A project can have 20 checks.</P>
            <List items={[
              <><B>What counts as up:</B> a response with the status you expect (any 2xx by default, or any 3xx, or an exact code), within the timeout, and with the text you asked for in the first 1 MB of the body. Redirects are followed, up to 5, and every address must be public.</>,
              <><B>Down after two failures in a row,</B> up again after one success, so a single dropped request never pages anyone.</>,
              <><B>Get notified:</B> every change of state is recorded as a <C>wgo.uptime</C> event with <C>props.check</C>, <C>props.state</C> (<C>up</C> or <C>down</C>), <C>props.status</C> and <C>props.error</C>. <B>Notify me</B> in a check opens a trigger on <C>name = wgo.uptime</C>, <C>props.check</C> and <C>props.state = down</C>, to send to Slack or a webhook.</>,
              <><B>Stored like other raw data,</B> and removed with the project's retention. Checks are made by the <C>UptimeFunction</C> Lambda, once a minute, and cost almost nothing when none are due.</>,
            ]} />
          </Section>

          <Section id="costs" title="What the install costs">
            <P>The <B>Costs</B> page shows what this WGO install costs in AWS this month, per day and per service, and about how much that is per million events. Only admins can open it: the emails in <C>ADMIN_EMAILS</C> in <C>deploy.env</C>, or, without it, the owners of the first project created. AWS has to be told once to track costs by stack:</P>
            <List items={[
              <>In the AWS Billing console, open <B>Cost allocation tags</B>, find <C>aws:cloudformation:stack-name</C> under <B>AWS-generated tags</B> and activate it. Costs show up about a day later.</>,
              <>WGO reads them from Cost Explorer, which charges $0.01 per request. It asks at most twice a day and keeps the answer in between (one hour while setup is still missing).</>,
              <>Usage comes from WGO's own hourly counts, the size of the data bucket and the database storage from CloudWatch.</>,
            ]} />
            <P><B>Budgets</B> set a monthly limit for the whole install or one project (a project's spend is estimated from its share of the month's events). They alert at the percentages you choose and when the month's forecast passes the limit, on the page and in Slack or a webhook. A budget can also <B>stop collecting data</B> at its limit: WGO then stops storing new data for that project, or every project, until next month, until the limit is raised or someone resumes it. Budgets are checked every 15 minutes.</P>
            <P><B>You're responsible for your AWS bill.</B> Cost figures, budgets and caps are estimates provided as they are, without any warranty, and the authors of WGO accept no responsibility or liability for any AWS charges. Cost Explorer can be a day behind, so spend can pass a limit before WGO notices, and stopping collection can't stop every charge: requests still reach AWS and stored data still costs. For alerts on your whole AWS account, also set up AWS Budgets in the AWS console.</P>
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
            <P>With more than one project, <B>All projects</B> (the logo, or the top of the project menu) shows them side by side. Each card has the site's homepage, its main numbers and a chart. WGO takes the site from the most viewed public address in the last three days, and screenshots its homepage once a day with headless Chromium.</P>
            <P>An owner can delete a project under <B>Settings → Delete project</B>. Members lose access and the write key stops working at once. Events, logs, traces, metrics and recordings are then deleted from the database and S3 over the next few minutes. This can't be undone.</P>
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
              <ThemedImg dark="docs/architecture-dark.svg" light="docs/architecture-light.svg" w={1530} h={770}
                alt="WGO architecture: web apps and OpenTelemetry services send data through CloudFront to an intake Lambda, which queues it in SQS; Lambdas write Parquet to S3; a maintenance Lambda compacts it and rolls it up into Aurora DSQL; the dashboard, widget, kiosks and MCP clients query it through Lambdas running DuckDB, and get live events over a WebSocket API" />
            </div>
            <List items={[
              <><B>Ingest.</B> A small Lambda behind CloudFront writes SDK batches and OTLP requests to SQS and answers straight away. Lambdas behind the queue write each batch to S3 as Parquet and, in parallel, push matching events to live watches over a WebSocket.</>,
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
