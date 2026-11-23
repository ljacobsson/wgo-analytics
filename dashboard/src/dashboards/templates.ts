import type { DashboardTile } from '../api/contract';
import { BUILTIN } from './measures';

/** Starting points for a new dashboard. Every tile is an ordinary tile: change or remove any of them. */

const m = (id: string) => {
  const d = BUILTIN.find((x) => x.id === id);
  if (!d) throw new Error(`No measure ${id}`);
  return d.measure;
};
let n = 0;
const t = (viz: DashboardTile['viz'], ids: string[], layout: DashboardTile['layout'], extra: Partial<DashboardTile> = {}): DashboardTile =>
  ({ id: `t${++n}`, viz, measures: ids.map(m), layout, ...extra });

export interface Template { id: string; name: string; description: string; tiles: () => DashboardTile[] }

export const TEMPLATES: Template[] = [
  {
    id: 'blank', name: 'Blank', description: 'Start empty and add what you need.', tiles: () => [],
  },
  {
    id: 'web', name: 'Web overview', description: 'Traffic, where it comes from, errors and Web Vitals.',
    tiles: () => [
      t('number', ['visitors'], { x: 0, y: 0, w: 3, h: 2 }),
      t('number', ['sessions'], { x: 3, y: 0, w: 3, h: 2 }),
      t('number', ['pageviews'], { x: 6, y: 0, w: 3, h: 2 }),
      t('number', ['error-sessions'], { x: 9, y: 0, w: 3, h: 2 }),
      t('area', ['pageviews'], { x: 0, y: 2, w: 8, h: 4 }),
      t('top', ['sessions'], { x: 8, y: 2, w: 4, h: 4 }, { groupBy: 'country' }),
      t('top', ['pageviews'], { x: 0, y: 6, w: 4, h: 4 }, { groupBy: 'path' }),
      t('top', ['sessions'], { x: 4, y: 6, w: 4, h: 4 }, { groupBy: 'referrer' }),
      t('bars', ['errors'], { x: 8, y: 6, w: 4, h: 4 }),
      t('line', ['vital:lcp'], { x: 0, y: 10, w: 6, h: 3 }, { groupBy: 'device', limit: 3 }),
      t('line', ['vital:inp'], { x: 6, y: 10, w: 6, h: 3 }, { groupBy: 'device', limit: 3 }),
    ],
  },
  {
    id: 'backend', name: 'Backend health', description: 'Latency, failures and error logs per service, and uptime.',
    tiles: () => [
      t('number', ['span-p95'], { x: 0, y: 0, w: 3, h: 2 }),
      t('number', ['span-errors'], { x: 3, y: 0, w: 3, h: 2 }),
      t('number', ['error-logs'], { x: 6, y: 0, w: 3, h: 2 }),
      t('number', ['uptime'], { x: 9, y: 0, w: 3, h: 2 }),
      t('line', ['span-p95'], { x: 0, y: 2, w: 6, h: 4 }, { groupBy: 'service' }),
      t('bars', ['span-errors'], { x: 6, y: 2, w: 6, h: 4 }, { groupBy: 'service' }),
      t('top', ['error-logs'], { x: 0, y: 6, w: 4, h: 4 }, { groupBy: 'service' }),
      t('table', ['span-p95'], { x: 4, y: 6, w: 4, h: 4 }, { groupBy: 'name' }),
      t('line', ['uptime-p95'], { x: 8, y: 6, w: 4, h: 4 }, { groupBy: 'checkId', limit: 5 }),
    ],
  },
  {
    id: 'everything', name: 'Web and backend', description: 'The headline numbers from the browser and your services, side by side.',
    tiles: () => [
      t('number', ['sessions', 'errors', 'vital:lcp'], { x: 0, y: 0, w: 6, h: 2 }),
      t('number', ['span-p95', 'span-errors', 'uptime'], { x: 6, y: 0, w: 6, h: 2 }),
      t('line', ['pageviews', 'spans'], { x: 0, y: 2, w: 6, h: 4 }, { title: 'Browser traffic vs backend load' }),
      t('line', ['http-errors', 'span-errors'], { x: 6, y: 2, w: 6, h: 4 }, { title: 'Failures, browser and backend' }),
      t('table', ['pageviews', 'sessions', 'errors', 'span-p95'], { x: 0, y: 6, w: 6, h: 3 }),
      t('top', ['error-logs'], { x: 6, y: 6, w: 6, h: 3 }, { groupBy: 'service' }),
    ],
  },
];
