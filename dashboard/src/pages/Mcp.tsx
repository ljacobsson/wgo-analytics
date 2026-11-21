import { useState } from 'react';
import { KeyRound, Lock, PlugZap, Sparkles } from 'lucide-react';
import { getConfig } from '../api/config';
import { useProject } from '../lib/project';
import { CodeBlock } from '../ui/CodeBlock';
import { Card, CardHeader, CopyButton, EmptyState, Mono, Segmented } from '../ui/kit';

type Client = 'claude-code' | 'claude' | 'vscode' | 'cursor' | 'other';
const CLIENTS: Array<{ value: Client; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' }, { value: 'claude', label: 'Claude app' }, { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' }, { value: 'other', label: 'Other' },
];

/** Keep in sync with backend/src/lib/mcp/tools.ts. */
const TOOLS: Array<{ group: string; tools: Array<[string, string]> }> = [
  {
    group: 'Setup',
    tools: [['create_project', 'New project with its script tag'], ['get_install_snippet', 'Script tag and OTLP settings']],
  },
  {
    group: 'Product analytics',
    tools: [
      ['list_projects', 'Your projects (start here)'], ['get_overview', 'Traffic totals and trend'], ['top_pages', 'Most viewed pages'],
      ['top_clicks', 'Most clicked elements'], ['goal_conversions', 'Conversion goals and rates'], ['list_errors', 'JavaScript errors'],
      ['list_failed_requests', 'Failed API calls'], ['breakdown', 'Sessions by browser, country…'], ['web_vitals', 'Core Web Vitals'],
      ['visitor_locations', 'Where visitors are'], ['search_events', 'Individual events'],
    ],
  },
  {
    group: 'Goals and triggers',
    tools: [
      ['create_goal', 'Define a conversion goal'], ['update_goal', 'Change a goal'], ['create_trigger', 'Alert to a webhook or Slack'],
      ['preview_trigger', 'Check a threshold before saving'], ['test_trigger', 'Send a test notification'],
    ],
  },
  {
    group: 'OpenTelemetry',
    tools: [
      ['list_services', 'Services, errors and latency'], ['list_traces', 'Search traces'], ['get_trace', 'One trace’s spans'],
      ['search_logs', 'Search logs'], ['list_metrics', 'Available metrics'], ['get_metric_series', 'A metric over time'],
    ],
  },
];

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-muted">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full grad-bg text-[11.5px] font-bold text-white">{i + 1}</span>
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">{item}</div>
        </li>))}
    </ol>
  );
}

function Instructions({ client, url, local }: { client: Client; url: string; local: boolean }) {
  const signIn = local
    ? <>The local dev server doesn’t ask you to sign in: the assistant acts as the dev user.</>
    : <>Your browser opens WGO’s sign-in page. Sign in with your WGO account and you’re connected.</>;
  switch (client) {
    case 'claude-code':
      return <Steps items={[
        <>Add the server from a terminal:<CodeBlock lang="sh" code={`claude mcp add --transport http wgo ${url}`} /></>,
        <>In Claude Code, run <Mono>/mcp</Mono>, pick <b className="text-fg">wgo</b> and choose <b className="text-fg">Authenticate</b>. {signIn}</>,
        <>Ask away. Add <Mono>--scope user</Mono> to the command to use WGO in every project, not just this directory.</>,
      ]} />;
    case 'claude':
      return <Steps items={[
        <>In Claude (web or desktop), open <b className="text-fg">Settings → Connectors</b> and click <b className="text-fg">Add custom connector</b>.</>,
        <>Name it <b className="text-fg">WGO</b> and paste this URL:<UrlBox url={url} /></>,
        <>Click <b className="text-fg">Connect</b>. {signIn}</>,
        <>In a chat, turn WGO on from the tools menu.{local && <span className="block text-[12px] text-warn">Claude connects from the internet, so it can’t reach a server on localhost. Use Claude Code or VS Code for local development.</span>}</>,
      ]} />;
    case 'vscode':
      return <Steps items={[
        <>Add this to <Mono>.vscode/mcp.json</Mono> in your workspace (or run <b className="text-fg">MCP: Add Server…</b> from the Command Palette, choose HTTP and paste the URL):
          <CodeBlock lang="js" wrap={false} code={`{\n  "servers": {\n    "wgo": {\n      "type": "http",\n      "url": "${url}"\n    }\n  }\n}`} /></>,
        <>Click <b className="text-fg">Start</b> above the server in <Mono>mcp.json</Mono>. {signIn}</>,
        <>Open Copilot Chat in <b className="text-fg">Agent</b> mode; WGO’s tools are listed under the tools button.</>,
      ]} />;
    case 'cursor':
      return <Steps items={[
        <>Add this to <Mono>~/.cursor/mcp.json</Mono> (every project) or <Mono>.cursor/mcp.json</Mono> (this project):
          <CodeBlock lang="js" wrap={false} code={`{\n  "mcpServers": {\n    "wgo": {\n      "url": "${url}"\n    }\n  }\n}`} /></>,
        <>Open <b className="text-fg">Cursor Settings → MCP</b> and click <b className="text-fg">Connect</b> next to wgo. {signIn}</>,
        <>Ask in the Agent chat.</>,
      ]} />;
    case 'other':
      return <Steps items={[
        <>WGO is a remote MCP server over <b className="text-fg">Streamable HTTP</b>:<UrlBox url={url} /></>,
        local
          ? <>Locally there is no authentication: any client can connect.</>
          : <>It uses <b className="text-fg">OAuth 2.1</b> with dynamic client registration: clients that support MCP authorization discover the sign-in page from the URL themselves. There’s no API key to configure.</>,
        <>Apart from creating a project and naming click targets, the tools are read-only: an assistant can’t change or delete your data or settings.</>,
      ]} />;
  }
}

function UrlBox({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-[var(--hl)] px-3 py-2">
      <Mono className="min-w-0 flex-1 truncate text-fg">{url}</Mono>
      <CopyButton text={url} />
    </div>
  );
}

export function McpPage() {
  const { project } = useProject();
  const config = getConfig();
  const url = config.mcpUrl;
  const local = !!config.devEmail;
  const [client, setClient] = useState<Client>(() => (localStorage.getItem('wgo.mcpClient') as Client) || 'claude-code');
  const pick = (c: Client) => { setClient(c); localStorage.setItem('wgo.mcpClient', c); };

  if (!url) {
    return (
      <Card>
        <EmptyState icon={<Sparkles size={22} />} title="MCP is turned off on this WGO">
          Whoever deployed WGO can turn it on by deploying again with <Mono>MCP_ENABLED=true</Mono> (the default). AI assistants then connect at
          <Mono> /mcp</Mono> on the dashboard’s address.
        </EmptyState>
      </Card>
    );
  }

  const examples = [
    `How did traffic to ${project.name} this week compare with last week?`,
    `Which JavaScript errors in ${project.name} hit the most sessions today, and on which pages?`,
    `How are the conversion goals in ${project.name} doing over the last 7 days?`,
    'Find the slowest traces from the last hour and explain where the time goes.',
  ];

  return (
    <div className="space-y-4">
      <p className="max-w-[860px] text-[13px] leading-relaxed text-muted">
        Connect Claude, VS Code, Cursor or any other MCP client to WGO and ask about traffic, conversions, errors, traces and metrics in plain
        language. The assistant looks up the numbers itself, so there are no screenshots to paste.
      </p>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Connect your assistant" sub={<span className="inline-flex items-center gap-1.5">Server URL <Mono className="text-muted">{url}</Mono></span>}
            right={<CopyButton text={url} />} />
          <div className="space-y-4 px-4 pb-5">
            <div className="overflow-x-auto"><Segmented value={client} onChange={pick} options={CLIENTS} /></div>
            <Instructions client={client} url={url} local={local} />
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="What it can see" />
            <ul className="space-y-2.5 px-4 pb-4 text-[12.5px] leading-relaxed text-muted">
              <li className="flex gap-2.5"><KeyRound size={15} className="mt-0.5 shrink-0 text-accent" />You sign in with your WGO account. There’s no API key to copy or leak.</li>
              <li className="flex gap-2.5"><Lock size={15} className="mt-0.5 shrink-0 text-accent" />Read-only, and only the projects you’re a member of: the same data you see here.</li>
              <li className="flex gap-2.5"><PlugZap size={15} className="mt-0.5 shrink-0 text-accent" />To disconnect, remove the server from your assistant.</li>
            </ul>
          </Card>
          <Card>
            <CardHeader title="Try asking" />
            <ul className="space-y-1.5 px-4 pb-4">
              {examples.map((e) => (
                <li key={e} className="group flex items-start gap-2 rounded-lg border border-line bg-[var(--hl)] px-3 py-2 text-[12.5px]">
                  <span className="min-w-0 flex-1">{e}</span>
                  <span className="opacity-0 transition-opacity group-hover:opacity-100"><CopyButton text={e} /></span>
                </li>))}
            </ul>
          </Card>
        </div>
      </div>
      <Card>
        <CardHeader title="Tools" sub={`${TOOLS.reduce((n, g) => n + g.tools.length, 0)} tools; the assistant picks which to call`} />
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 px-4 pb-4 md:grid-cols-2">
          {TOOLS.map((g) => (
            <div key={g.group}>
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{g.group}</div>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                {g.tools.map(([name, what]) => <div key={name} className="contents"><Mono className="text-[12px] text-fg">{name}</Mono><span className="text-[12.5px] text-muted">{what}</span></div>)}
              </div>
            </div>))}
        </div>
      </Card>
    </div>
  );
}
