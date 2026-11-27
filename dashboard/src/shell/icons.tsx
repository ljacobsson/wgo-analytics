import { Bot, LayoutDashboard, PanelsTopLeft, Radio, MousePointerClick, Bug, Globe, ListTree, Waypoints, ScrollText, LineChart, Settings, Smartphone, BellRing, Tv, Target, Sparkles, MonitorPlay, Rocket, Activity, Wallet, Repeat2, Split, Database } from 'lucide-react';
const MAP = { overview: LayoutDashboard, dashboards: PanelsTopLeft, live: Radio, clicks: MousePointerClick, errors: Bug, network: Globe, events: ListTree, goals: Target, triggers: BellRing, traces: Waypoints, logs: ScrollText, metrics: LineChart, settings: Settings, widget: Smartphone, kiosks: Tv, mcp: Sparkles, recordings: MonitorPlay, releases: Rocket, uptime: Activity, costs: Wallet, 'fix-agent': Bot, retention: Repeat2, flows: Split, sql: Database } as const;
export function PageIcon({ id, size = 16 }: { id: string; size?: number }) {
  const I = MAP[id as keyof typeof MAP] ?? LayoutDashboard;
  return <I size={size} strokeWidth={1.8} />;
}
