import { LayoutDashboard, Radio, MousePointerClick, Bug, Globe, ListTree, Waypoints, ScrollText, LineChart, Settings, Smartphone, BellRing, Tv, Target, Sparkles, MonitorPlay } from 'lucide-react';
const MAP = { overview: LayoutDashboard, live: Radio, clicks: MousePointerClick, errors: Bug, network: Globe, events: ListTree, goals: Target, triggers: BellRing, traces: Waypoints, logs: ScrollText, metrics: LineChart, settings: Settings, widget: Smartphone, kiosks: Tv, mcp: Sparkles, recordings: MonitorPlay } as const;
export function PageIcon({ id, size = 16 }: { id: string; size?: number }) {
  const I = MAP[id as keyof typeof MAP] ?? LayoutDashboard;
  return <I size={size} strokeWidth={1.8} />;
}
