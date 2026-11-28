import { createContext, useContext } from 'react';
import type { Project } from '../api/contract';

export const ProjectCtx = createContext<{ project: Project; projects: Project[]; email: string }>(null as never);
export const useProject = () => useContext(ProjectCtx);

/** Sidebar sections, in order. The first one has no heading. */
export const NAV_GROUPS = ['Home', 'Behavior', 'Conversion', 'Reliability', 'Observability', 'Connect'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];
export interface PageDef { id: string; label: string; group: NavGroup; key: string; icon: string }
export const PAGES: PageDef[] = [
  { id: 'overview', label: 'Overview', group: 'Home', key: 'o', icon: 'overview' },
  { id: 'live', label: 'Live', group: 'Home', key: 'l', icon: 'live' },
  { id: 'dashboards', label: 'Dashboards', group: 'Home', key: 'h', icon: 'dashboards' },
  { id: 'events', label: 'Events', group: 'Behavior', key: 'v', icon: 'events' },
  { id: 'clicks', label: 'Clicks', group: 'Behavior', key: 'c', icon: 'clicks' },
  { id: 'recordings', label: 'Recordings', group: 'Behavior', key: 'p', icon: 'recordings' },
  { id: 'flows', label: 'User flows', group: 'Behavior', key: 'f', icon: 'flows' },
  { id: 'goals', label: 'Goals', group: 'Conversion', key: 'r', icon: 'goals' },
  { id: 'retention', label: 'Retention', group: 'Conversion', key: 'b', icon: 'retention' },
  { id: 'surveys', label: 'Surveys', group: 'Conversion', key: 'y', icon: 'surveys' },
  { id: 'errors', label: 'Errors', group: 'Reliability', key: 'e', icon: 'errors' },
  { id: 'network', label: 'Network', group: 'Reliability', key: 'n', icon: 'network' },
  { id: 'releases', label: 'Releases', group: 'Reliability', key: 'd', icon: 'releases' },
  { id: 'uptime', label: 'Uptime', group: 'Reliability', key: 'u', icon: 'uptime' },
  { id: 'traces', label: 'Traces', group: 'Observability', key: 't', icon: 'traces' },
  { id: 'logs', label: 'Logs', group: 'Observability', key: 'g', icon: 'logs' },
  { id: 'metrics', label: 'Metrics', group: 'Observability', key: 'm', icon: 'metrics' },
  { id: 'sql', label: 'SQL', group: 'Observability', key: 'q', icon: 'sql' },
  { id: 'triggers', label: 'Triggers', group: 'Connect', key: 'a', icon: 'triggers' },
];
