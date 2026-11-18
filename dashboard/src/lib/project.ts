import { createContext, useContext } from 'react';
import type { Project } from '../api/contract';

export const ProjectCtx = createContext<{ project: Project; projects: Project[]; email: string }>(null as never);
export const useProject = () => useContext(ProjectCtx);

export interface PageDef { id: string; label: string; group: 'Product' | 'Observability'; key: string; icon: string }
export const PAGES: PageDef[] = [
  { id: 'overview', label: 'Overview', group: 'Product', key: 'o', icon: 'overview' },
  { id: 'live', label: 'Live', group: 'Product', key: 'l', icon: 'live' },
  { id: 'clicks', label: 'Clicks', group: 'Product', key: 'c', icon: 'clicks' },
  { id: 'errors', label: 'Errors', group: 'Product', key: 'e', icon: 'errors' },
  { id: 'network', label: 'Network', group: 'Product', key: 'n', icon: 'network' },
  { id: 'events', label: 'Events', group: 'Product', key: 'v', icon: 'events' },
  { id: 'recordings', label: 'Recordings', group: 'Product', key: 'p', icon: 'recordings' },
  { id: 'goals', label: 'Goals', group: 'Product', key: 'r', icon: 'goals' },
  { id: 'triggers', label: 'Triggers', group: 'Product', key: 'a', icon: 'triggers' },
  { id: 'traces', label: 'Traces', group: 'Observability', key: 't', icon: 'traces' },
  { id: 'logs', label: 'Logs', group: 'Observability', key: 'g', icon: 'logs' },
  { id: 'metrics', label: 'Metrics', group: 'Observability', key: 'm', icon: 'metrics' },
];
