import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  Device, DeviceCreated, Kiosk, KioskConfig,
  BreakdownRow, ClickRow, ErrorGroup, EventsResponse, GeoResponse, HttpErrorGroup, LogsResponse, Me, Member, MetricInfo,
  MetricSeriesResponse, PageRow, Project, ServiceRow, StatsResponse, Totals, TraceResponse, TraceSummary, VitalsResponse, FieldsResponse, FieldValuesResponse, FilterScope, SlackIntegration, SlackChannel, Destination, DestinationInput, DestinationLevel, Trigger, TriggerInput, TriggerTestResult, SlackSetup, SlackTemplate, SlackWorkspace,
  SavedView, SavedViewInput, Goal, GoalInput, GoalStep, GoalFunnel, FlowsResponse, ConversionsResponse, ClickAlias, RetentionResponse,
  ReleasesResponse, Explanation, ExplainMetric, Filter, UploadKey, FrustrationRow, HeatmapResponse, HoursResponse,
  UptimeCheck, UptimeCheckInput, UptimeResults, UptimeRunResult, CostsResponse, TriggerPreview, ErrorSuppression, ErrorSuppressionInput, Budget, BudgetInput,
  RecordingsResponse, RecordingResponse, RecordingSettings, RecordingSettingsResponse, RecordingFilters, ProjectSite,
  Dashboard, DashboardInput, DashboardSummary, DashboardTile, MeasureNames, QueryResult, QuerySpec,
  FixRun, FixSettings, FixSettingsInput, GithubAppStatus, GithubManifestForm, GithubRepo, FixAgentAdmin, FixAgentConfigInput, FixTarget, FixTargetInfo, InstallFeatures, InstallSettings,
} from './contract';
import type { SqlExport, SqlExportRequest, SqlRequest, SqlResult, SqlSchema } from './contract';
import type { Survey, SurveyInput, SurveyResponse, SurveyResponsesPage, SurveyResults } from './contract';
import type { DevTrafficSettings } from './contract';
import { previousWindow, type TimeRange } from '../lib/time';
import { filtersParam, trafficParams, type FieldScope } from '../lib/filters';

const STALE = 20_000;
const base = (pid: string) => `/api/projects/${pid}`;
const rp = (r: Pick<TimeRange, 'from' | 'to'>) => ({ from: r.from, to: r.to });

export const keys = {
  me: ['me'] as const,
  members: (pid: string) => ['members', pid] as const,
  devices: ['devices'] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api<Me>('/api/me'), staleTime: 60_000 });
}

// which filter scope (URL param) applies to each endpoint
const SCOPE: Record<string, FilterScope | undefined> = {
  stats: 'events', hours: 'events', totals: 'events', clicks: 'events', frustration: 'events', heatmap: 'events', pages: 'events', errors: 'events', 'http-errors': 'events', breakdown: 'events',
  vitals: 'events', geo: 'events', conversions: 'events', flows: 'events', releases: 'events', explain: 'events', services: 'spans', traces: 'spans',
};

function q<T>(pid: string, name: string, r: TimeRange, path: string, extra: Record<string, string | number | boolean | undefined> = {}, enabled = true) {
  const scope = SCOPE[name];
  const params = scope ? { ...extra, filters: filtersParam(scope), ...(scope === 'events' ? trafficParams() : {}) } : extra;
  return {
    queryKey: [name, pid, r.from, r.to, params] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => api<T>(`${base(pid)}/${path}`, { params: { ...rp(r), ...params }, signal }),
    staleTime: STALE, placeholderData: keepPreviousData, enabled,
  };
}
// the comparison window comes from usePreviousTotals, which refreshes far less often
export const useStats = (pid: string, r: TimeRange) => useQuery(q<StatsResponse>(pid, 'stats', r, 'stats', { compare: 0 }));
/** Traffic per hour of the day in the viewer's time zone. */
export const useHours = (pid: string, r: TimeRange) =>
  useQuery(q<HoursResponse>(pid, 'hours', r, 'hours', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone }));
export function usePreviousTotals(pid: string, r: TimeRange) {
  const w = previousWindow(r);
  return useQuery({ ...q<Totals>(pid, 'totals', { ...r, ...w }, 'totals'), queryKey: ['totals', pid, w.from, w.to, filtersParam('events'), trafficParams()] as const, staleTime: 10 * 60_000 });
}
export const useClicks = (pid: string, r: TimeRange) => useQuery(q<ClickRow[]>(pid, 'clicks', r, 'clicks', { limit: 100 }));
export const usePages = (pid: string, r: TimeRange, limit = 10) => useQuery(q<PageRow[]>(pid, 'pages', r, 'pages', { limit }));
export const useFrustration = (pid: string, r: TimeRange) => useQuery(q<FrustrationRow[]>(pid, 'frustration', r, 'frustration', { limit: 100 }));
export const useHeatmap = (pid: string, r: TimeRange, path: string, device: 'desktop' | 'mobile') =>
  useQuery(q<HeatmapResponse>(pid, 'heatmap', r, 'heatmap', { path, device }, !!path));
export const useErrors = (pid: string, r: TimeRange) => useQuery(q<ErrorGroup[]>(pid, 'errors', r, 'errors', { limit: 100 }));
export const useHttpErrors = (pid: string, r: TimeRange) => useQuery(q<HttpErrorGroup[]>(pid, 'http-errors', r, 'http-errors', { limit: 100 }));
export const useBreakdown = (pid: string, r: TimeRange, dim: string) => useQuery(q<BreakdownRow[]>(pid, 'breakdown', r, 'breakdown', { dim }));
export const useVitals = (pid: string, r: TimeRange) => useQuery(q<VitalsResponse>(pid, 'vitals', r, 'vitals'));
export const useReleases = (pid: string, r: TimeRange) => useQuery(q<ReleasesResponse>(pid, 'releases', r, 'releases'));
/** What a metric's change in the range (vs the window before) comes from. */
export const useExplain = (pid: string, r: TimeRange, spec: { metric: ExplainMetric; where?: Filter[]; goalId?: string; label?: string } | null) =>
  useQuery({ ...q<Explanation>(pid, 'explain', r, 'explain', spec ? { metric: spec.metric, where: spec.where?.length ? JSON.stringify(spec.where) : undefined, goalId: spec.goalId, label: spec.label } : {}, !!spec), placeholderData: undefined, staleTime: 60_000 });
/** Deploys in the range (releases first seen in it), for chart markers. */
export const useReleaseMarkers = (pid: string, r: TimeRange) =>
  useQuery({ queryKey: ['release-markers', pid, r.from, r.to], queryFn: () => api<ReleasesResponse>(`${base(pid)}/releases`, { params: { ...rp(r), markers: 1 } }), staleTime: 60_000, select: (d) => d.markers });
export const useGeo = (pid: string, r: TimeRange) => useQuery(q<GeoResponse>(pid, 'geo', r, 'geo'));
export const useConversions = (pid: string, r: TimeRange) => useQuery(q<ConversionsResponse>(pid, 'conversions', r, 'conversions'));
/** The same-length window before `r`, without sparklines, refreshed far less often (like usePreviousTotals). */
export function usePreviousConversions(pid: string, r: TimeRange) {
  const w = previousWindow(r);
  return useQuery({ ...q<ConversionsResponse>(pid, 'conversions', { ...r, ...w }, 'conversions', { series: 0 }), staleTime: 10 * 60_000 });
}
/**
 * How sessions reach one goal. `steps` previews unsaved funnel steps (undefined = the goal's own). Keyed under
 * 'conversions' so goal edits refetch it too.
 */
export function useGoalFunnel(pid: string, goalId: string, r: TimeRange, steps?: GoalStep[]) {
  const o = q<GoalFunnel>(pid, 'conversions', r, `goals/${goalId}/funnel`, { steps: steps && JSON.stringify(steps) });
  return useQuery({ ...o, queryKey: [...o.queryKey, 'funnel', goalId] as const });
}
/** User flows: pages viewed one after another from the entry page (or `start`), with exits and errors per step. */
export const useFlows = (pid: string, r: TimeRange, start: string | null, steps: number) =>
  useQuery(q<FlowsResponse>(pid, 'flows', r, 'flows', { start: start ?? undefined, steps }));
export interface RetentionParams { from: string; to: string; period: string; start: string; return: string; split: string }
/** Retention cohorts. Not scoped to the page filters: visitor_days hold their own 400 days, so the page picks its own range. */
export const useRetention = (pid: string, p: RetentionParams) => useQuery({
  queryKey: ['retention', pid, p] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => api<RetentionResponse>(`${base(pid)}/retention`, { params: { ...p }, signal }),
  staleTime: 60_000, placeholderData: keepPreviousData,
});
export const useServices = (pid: string, r: TimeRange) => useQuery(q<ServiceRow[]>(pid, 'services', r, 'services'));
export const useMetrics = (pid: string, r: TimeRange) => useQuery(q<MetricInfo[]>(pid, 'metrics', r, 'metrics'));
export const useMetricSeries = (pid: string, r: TimeRange, name: string | null, service: string, agg: string, groupBy: string) =>
  useQuery(q<MetricSeriesResponse>(pid, 'metric-series', r, 'metrics/series', { name: name ?? '', service: service || undefined, agg, groupBy: groupBy || undefined }, !!name));
export const useTraces = (pid: string, r: TimeRange, f: { service?: string; minDurationMs?: number; errorsOnly?: boolean; q?: string }) =>
  useQuery(q<TraceSummary[]>(pid, 'traces', r, 'traces', { limit: 200, ...f }));
/** `at`: any time within the trace (its start, a log record's time), so the API looks in the right day first */
export const useTrace = (pid: string, traceId: string | null, at?: string | null) =>
  useQuery({ queryKey: ['trace', pid, traceId], queryFn: () => api<TraceResponse>(`${base(pid)}/traces/${traceId}`, { params: at ? { at } : {} }), enabled: !!traceId, staleTime: 5 * 60_000 });

export function useEvents(pid: string, r: TimeRange, base_: { type?: string; q?: string; sessionId?: string; fingerprint?: string }, enabled = true, limit = 100) {
  const f = { ...base_, filters: filtersParam('events'), ...trafficParams() };
  return useInfiniteQuery({
    queryKey: ['events', pid, r.from, r.to, f, limit],
    queryFn: ({ pageParam, signal }) => api<EventsResponse>(`${base(pid)}/events`, { params: { from: r.from, to: r.to, ...f, limit, before: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextBefore ?? undefined,
    staleTime: STALE, placeholderData: keepPreviousData, enabled,
  });
}
export function useLogs(pid: string, r: TimeRange, base_: { severity?: number; service?: string; traceId?: string; q?: string }, live: boolean) {
  const f = { ...base_, filters: filtersParam('logs') };
  return useInfiniteQuery({
    queryKey: ['logs', pid, r.from, r.to, f],
    queryFn: ({ pageParam, signal }) => api<LogsResponse>(`${base(pid)}/logs`, { params: { from: r.from, to: r.to, ...f, limit: 200, before: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextBefore ?? undefined,
    staleTime: STALE, placeholderData: keepPreviousData, refetchInterval: live ? 3000 : false,
  });
}

/** Warm the cache for a page when the user hovers its nav item. */
export function prefetchPage(qc: QueryClient, pid: string, page: string, r: TimeRange) {
  const pre = (name: string, path: string, params: Record<string, string | number> = {}) =>
    qc.prefetchQuery({ queryKey: [name, pid, r.from, r.to, params], queryFn: () => api(`${base(pid)}/${path}`, { params: { ...rp(r), ...params } }), staleTime: STALE });
  switch (page) {
    case 'overview': pre('stats', 'stats', { compare: 0 }); pre('pages', 'pages', { limit: 10 }); pre('clicks', 'clicks', { limit: 100 }); break;
    case 'clicks': pre('clicks', 'clicks', { limit: 100 }); break;
    case 'goals': pre('conversions', 'conversions'); break;
    case 'errors': pre('errors', 'errors', { limit: 100 }); break;
    case 'network': pre('http-errors', 'http-errors', { limit: 100 }); break;
    case 'traces': pre('services', 'services'); pre('traces', 'traces', { limit: 200 }); break;
    case 'metrics': pre('metrics', 'metrics'); break;
  }
}

// ---------- mutations with optimistic updates ----------
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<Project>('/api/projects', { method: 'POST', body: { name } }),
    onSuccess: (p) => qc.setQueryData<Me>(keys.me, (m) => (m ? { ...m, projects: [...m.projects, p] } : m)),
  });
}
export function useRenameProject(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<Project>(`/api/projects/${pid}`, { method: 'PATCH', body: { name } }),
    onMutate: async (name) => {
      const prev = qc.getQueryData<Me>(keys.me);
      qc.setQueryData<Me>(keys.me, (m) => m && { ...m, projects: m.projects.map((p) => (p.id === pid ? { ...p, name } : p)) });
      return { prev };
    },
    onError: (_e, _v, c) => c?.prev && qc.setQueryData(keys.me, c.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}
export function useSetRetention(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (retentionDays: number) => api<Project>(`/api/projects/${pid}`, { method: 'PATCH', body: { retentionDays } }),
    onSuccess: (p) => qc.setQueryData<Me>(keys.me, (m) => m && { ...m, projects: m.projects.map((x) => (x.id === pid ? p : x)) }),
  });
}
export function useSetDevTraffic(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (devTraffic: DevTrafficSettings) => api<Project>(`/api/projects/${pid}`, { method: 'PATCH', body: { devTraffic } }),
    onSuccess: (p) => qc.setQueryData<Me>(keys.me, (m) => m && { ...m, projects: m.projects.map((x) => (x.id === pid ? p : x)) }),
  });
}
export function useRotateKey(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<Project>(`/api/projects/${pid}/rotate-key`, { method: 'POST' }),
    onSuccess: (p) => qc.setQueryData<Me>(keys.me, (m) => m && { ...m, projects: m.projects.map((x) => (x.id === pid ? p : x)) }),
  });
}
export function useDeleteProject(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>(`/api/projects/${pid}`, { method: 'DELETE' }),
    // dropping it from the list sends the app to another project (or onboarding when it was the last one)
    onSuccess: () => qc.setQueryData<Me>(keys.me, (m) => m && { ...m, projects: m.projects.filter((x) => x.id !== pid) }),
  });
}
export const useUploadKey = (pid: string, enabled: boolean) => useQuery({ queryKey: ['upload-key', pid] as const, queryFn: () => api<UploadKey>(`/api/projects/${pid}/upload-key`), enabled, staleTime: Infinity });
export function useRotateUploadKey(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<UploadKey>(`/api/projects/${pid}/rotate-upload-key`, { method: 'POST' }),
    onSuccess: (k) => qc.setQueryData(['upload-key', pid], k),
  });
}
export const useMembers = (pid: string) => useQuery({ queryKey: keys.members(pid), queryFn: () => api<Member[]>(`${base(pid)}/members`), staleTime: 30_000 });
export function useInviteMember(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => api<Member>(`${base(pid)}/members`, { method: 'POST', body: { email } }),
    onMutate: async (email) => {
      await qc.cancelQueries({ queryKey: keys.members(pid) });
      const prev = qc.getQueryData<Member[]>(keys.members(pid));
      qc.setQueryData<Member[]>(keys.members(pid), (m = []) => [...m, { email, role: 'member', createdAt: new Date().toISOString() }]);
      return { prev };
    },
    onError: (_e, _v, c) => qc.setQueryData(keys.members(pid), c?.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.members(pid) }),
  });
}
export function useRemoveMember(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => api<{ ok: true }>(`${base(pid)}/members/${encodeURIComponent(email)}`, { method: 'DELETE' }),
    onMutate: async (email) => {
      await qc.cancelQueries({ queryKey: keys.members(pid) });
      const prev = qc.getQueryData<Member[]>(keys.members(pid));
      qc.setQueryData<Member[]>(keys.members(pid), (m = []) => m.filter((x) => x.email !== email));
      return { prev };
    },
    onError: (_e, _v, c) => qc.setQueryData(keys.members(pid), c?.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.members(pid) }),
  });
}

// ---------- devices (Android widget) ----------
export const useDevices = () => useQuery({ queryKey: keys.devices, queryFn: () => api<Device[]>('/api/devices'), staleTime: 15_000 });
export function useCreateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<DeviceCreated>('/api/devices', { method: 'POST', body: { name } }),
    onSuccess: (r) => qc.setQueryData<Device[]>(keys.devices, (d = []) => [r.device, ...d]),
  });
}
export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/devices/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.devices });
      const prev = qc.getQueryData<Device[]>(keys.devices);
      qc.setQueryData<Device[]>(keys.devices, (d = []) => d.filter((x) => x.id !== id));
      return { prev };
    },
    onError: (_e, _v, c) => qc.setQueryData(keys.devices, c?.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.devices }),
  });
}

/** `metric` narrows the metrics scope to one OpenTelemetry metric's attributes. */
export const useFields = (pid: string, r: TimeRange, scope: FieldScope, enabled = true, metric?: string) =>
  useQuery({
    queryKey: ['fields', pid, scope, metric, r.from, r.to],
    queryFn: ({ signal }) => api<FieldsResponse>(`${base(pid)}/fields`, { params: { ...rp(r), scope, metric }, signal }),
    staleTime: 5 * 60_000, enabled,
  });
export const useFieldValues = (pid: string, r: TimeRange, scope: FieldScope, field: string, q: string, enabled = true, metric?: string) =>
  useQuery({
    queryKey: ['field-values', pid, scope, metric, field, q, r.from, r.to],
    queryFn: ({ signal }) => api<FieldValuesResponse>(`${base(pid)}/fields/values`, { params: { ...rp(r), scope, field, metric, q: q || undefined }, signal }),
    staleTime: 60_000, placeholderData: keepPreviousData, enabled: enabled && !!field,
  });

// ---------- saved views ----------
const viewsKey = (pid: string) => ['views', pid] as const;
export const useViews = (pid: string, enabled = true) =>
  useQuery({ queryKey: viewsKey(pid), queryFn: () => api<SavedView[]>(`${base(pid)}/views`), staleTime: 60_000, enabled });
export function useSaveView(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<SavedViewInput> }) =>
      id ? api<SavedView>(`${base(pid)}/views/${id}`, { method: 'PATCH', body: input }) : api<SavedView>(`${base(pid)}/views`, { method: 'POST', body: input }),
    onSettled: () => qc.invalidateQueries({ queryKey: viewsKey(pid) }),
  });
}
export function useDeleteView(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/views/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: viewsKey(pid) });
      qc.setQueryData<SavedView[]>(viewsKey(pid), (cur) => cur?.filter((v) => v.id !== id));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: viewsKey(pid) }),
  });
}

// ---------- click aliases ----------
const aliasesKey = (pid: string) => ['click-aliases', pid] as const;
/** selector → alias, for labelling clicks in event lists. */
export function useClickAliases(pid: string) {
  return useQuery({
    queryKey: aliasesKey(pid), queryFn: () => api<ClickAlias[]>(`${base(pid)}/click-aliases`), staleTime: 5 * 60_000,
    select: (list) => new Map(list.map((a) => [a.selector, a.alias])),
  });
}
/** Sets a selector's alias, or removes it when `alias` is blank. Click rows carry the alias, so they refetch too. */
export function useSetClickAlias(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ selector, alias }: { selector: string; alias: string }): Promise<unknown> =>
      alias.trim()
        ? api<ClickAlias>(`${base(pid)}/click-aliases`, { method: 'POST', body: { selector, alias } })
        : api<{ ok: true }>(`${base(pid)}/click-aliases`, { method: 'DELETE', params: { selector } }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: aliasesKey(pid) }), qc.invalidateQueries({ queryKey: ['clicks', pid] })]),
  });
}

// ---------- conversion goals ----------
const goalsKey = (pid: string) => ['goals', pid] as const;
export const useGoals = (pid: string) =>
  useQuery({ queryKey: goalsKey(pid), queryFn: () => api<Goal[]>(`${base(pid)}/goals`), staleTime: 60_000 });
/** Goal changes also change every conversions answer, so those refetch too. */
const invalidateGoals = (qc: QueryClient, pid: string) =>
  Promise.all([qc.invalidateQueries({ queryKey: goalsKey(pid) }), qc.invalidateQueries({ queryKey: ['conversions', pid] })]);
export function useSaveGoal(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<GoalInput> }) =>
      id ? api<Goal>(`${base(pid)}/goals/${id}`, { method: 'PATCH', body: input }) : api<Goal>(`${base(pid)}/goals`, { method: 'POST', body: input }),
    onSettled: () => invalidateGoals(qc, pid),
  });
}
export function useDeleteGoal(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/goals/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: goalsKey(pid) });
      qc.setQueryData<Goal[]>(goalsKey(pid), (cur) => cur?.filter((g) => g.id !== id));
    },
    onSettled: () => invalidateGoals(qc, pid),
  });
}

// ---------- triggers ----------
const triggersKey = (pid: string) => ['triggers', pid] as const;
const integrationsKey = (pid: string) => ['integrations', pid] as const;

export const useTriggers = (pid: string) =>
  useQuery({ queryKey: triggersKey(pid), queryFn: () => api<Trigger[]>(`${base(pid)}/triggers`), staleTime: 15_000 });
export const useIntegrations = (pid: string) =>
  useQuery({ queryKey: integrationsKey(pid), queryFn: () => api<SlackIntegration[]>(`${base(pid)}/integrations`), staleTime: 60_000 });

export function useSaveTrigger(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<TriggerInput> }) =>
      id ? api<Trigger>(`${base(pid)}/triggers/${id}`, { method: 'PATCH', body: input }) : api<Trigger>(`${base(pid)}/triggers`, { method: 'POST', body: input }),
    onSettled: () => qc.invalidateQueries({ queryKey: triggersKey(pid) }),
  });
}
export function useDeleteTrigger(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/triggers/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: triggersKey(pid) });
      qc.setQueryData<Trigger[]>(triggersKey(pid), (cur) => cur?.filter((t) => t.id !== id));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: triggersKey(pid) }),
  });
}
const suppressionsKey = (pid: string) => ['error-suppressions', pid] as const;
export const useSuppressions = (pid: string) =>
  useQuery({ queryKey: suppressionsKey(pid), queryFn: () => api<ErrorSuppression[]>(`${base(pid)}/error-suppressions`), staleTime: 30_000 });
export function useSaveSuppression(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ErrorSuppressionInput) => api<ErrorSuppression>(`${base(pid)}/error-suppressions`, { method: 'POST', body: input }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: suppressionsKey(pid) }); void qc.invalidateQueries({ queryKey: ['errors', pid] }); },
  });
}
export function useDeleteSuppression(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/error-suppressions/${id}`, { method: 'DELETE' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: suppressionsKey(pid) }); void qc.invalidateQueries({ queryKey: ['errors', pid] }); },
  });
}
/** The current value of an unsaved threshold/anomaly trigger (debounced by the query key). */
export function useTriggerPreview(pid: string, input: Partial<TriggerInput> | null) {
  const key = input ? JSON.stringify(input) : '';
  return useQuery({
    queryKey: ['trigger-preview', pid, key], enabled: !!input, staleTime: 30_000, retry: false,
    queryFn: () => api<TriggerPreview>(`${base(pid)}/triggers/preview`, { method: 'POST', body: input! }),
  });
}
export function useTestTrigger(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    // slackTemplate: try a Slack message design before saving it
    mutationFn: (a: string | { id: string; slackTemplate?: SlackTemplate | null }) => {
      const { id, slackTemplate } = typeof a === 'string' ? { id: a, slackTemplate: undefined } : a;
      return api<TriggerTestResult>(`${base(pid)}/triggers/${id}/test`, { method: 'POST', ...(slackTemplate ? { body: { slackTemplate } } : {}) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: triggersKey(pid) }),
  });
}
export function useDeleteIntegration(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/integrations/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: integrationsKey(pid) }),
  });
}
/**
 * One click: fetch the signed "Add to Slack" URL and go there; Slack asks for a workspace and sends the user back to
 * Triggers. `account` connects the workspace for the user's own channels instead of the project's.
 */
export async function startSlackInstall(pid: string, level: DestinationLevel = 'project'): Promise<void> {
  const { url } = await api<{ url: string }>(`${base(pid)}/slack/install`, { params: { level } });
  window.location.assign(url);
}

// ---------- saved destinations (the project's and the user's own) ----------
const destinationsKey = (pid: string) => ['destinations', pid] as const;
/** The project's destinations, then the user's own: what a trigger here can pick. */
export const useDestinations = (pid: string) =>
  useQuery({ queryKey: destinationsKey(pid), queryFn: () => api<Destination[]>(`${base(pid)}/destinations`), staleTime: 60_000 });
const destinationPath = (pid: string, level: DestinationLevel, id?: string) =>
  `${level === 'account' ? '/api/destinations' : `${base(pid)}/destinations`}${id ? `/${id}` : ''}`;
/** Account destinations show up in every project, and project Slack channels in the old integrations list. */
const invalidateDestinations = (qc: ReturnType<typeof useQueryClient>, pid: string) => {
  void qc.invalidateQueries({ queryKey: ['destinations'] });
  void qc.invalidateQueries({ queryKey: ['slack-setup'] }); // workspaces count their channels
  void qc.invalidateQueries({ queryKey: integrationsKey(pid) });
  void qc.invalidateQueries({ queryKey: triggersKey(pid) });
};
export function useSaveDestination(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, level, input }: { id?: string; level: DestinationLevel; input: Partial<DestinationInput> }) =>
      api<Destination>(destinationPath(pid, level, id), { method: id ? 'PATCH' : 'POST', body: input }),
    onSettled: () => invalidateDestinations(qc, pid),
  });
}
export function useDeleteDestination(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, level }: { id: string; level: DestinationLevel }) => api<{ ok: true }>(destinationPath(pid, level, id), { method: 'DELETE' }),
    onSettled: () => invalidateDestinations(qc, pid),
  });
}
export const useTestDestination = (pid: string) =>
  useMutation({ mutationFn: ({ id, level }: { id: string; level: DestinationLevel }) => api<TriggerTestResult>(`${destinationPath(pid, level, id)}/test`, { method: 'POST' }) });

const slackKey = (pid: string) => ['slack-setup', pid] as const;
export const useSlackSetup = (pid: string) =>
  useQuery({ queryKey: slackKey(pid), queryFn: () => api<SlackSetup>(`${base(pid)}/slack`), staleTime: 60_000 });
/**
 * Connects a Slack workspace with a bot token: the project's, or your own (`account`). Resolves once the setup is
 * refetched, so the new workspace is in it.
 */
export function useConnectSlackToken(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { token: string; level: DestinationLevel }) => api<SlackWorkspace>(`${base(pid)}/slack/workspaces`, { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['slack-setup'] }), // your own workspaces show in every project
  });
}
/** Channels WGO can post to in a connected workspace (public ones, and private ones its bot was invited to). */
export const useSlackChannels = (pid: string, workspaceId: string | null) =>
  useQuery({
    queryKey: ['slack-channels', pid, workspaceId], enabled: !!workspaceId, staleTime: 60_000, retry: false,
    queryFn: () => api<SlackChannel[]>(`${base(pid)}/slack/workspaces/${workspaceId}/channels`),
  });
/** Adds a channel as a destination, at its workspace's level (the project's, or the user's own). */
export function useAddSlackChannel(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, channelId }: { workspaceId: string; channelId: string }) =>
      api<Destination>(`${base(pid)}/slack/workspaces/${workspaceId}/channels`, { method: 'POST', body: { channelId } }),
    onSettled: () => invalidateDestinations(qc, pid),
  });
}
export function useDisconnectSlackWorkspace(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => api<SlackSetup>(`${base(pid)}/slack/workspaces/${workspaceId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slack-setup'] }), // your own workspaces show in every project
  });
}

// ---------- kiosks (wall displays) ----------
const kiosksKey = (pid: string) => ['kiosks', pid] as const;
/** Polled while the page is open, so a screen's online status stays current. */
export const useKiosks = (pid: string, poll = false) =>
  useQuery({ queryKey: kiosksKey(pid), queryFn: () => api<Kiosk[]>(`${base(pid)}/kiosks`), staleTime: 10_000, refetchInterval: poll ? 15_000 : false });
export function useCreateKiosk(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; config?: Partial<KioskConfig> }) => api<Kiosk>(`${base(pid)}/kiosks`, { method: 'POST', body: input }),
    onSuccess: (k) => qc.setQueryData<Kiosk[]>(kiosksKey(pid), (l = []) => [...l, k]),
  });
}
export function useUpdateKiosk(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; name?: string; config?: Partial<KioskConfig>; reload?: boolean }) =>
      api<Kiosk>(`${base(pid)}/kiosks/${id}`, { method: 'PATCH', body: input }),
    onSuccess: (k) => qc.setQueryData<Kiosk[]>(kiosksKey(pid), (l = []) => l.map((x) => (x.id === k.id ? k : x))),
  });
}
export function useRotateKiosk(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Kiosk>(`${base(pid)}/kiosks/${id}/rotate`, { method: 'POST' }),
    onSuccess: (k) => qc.setQueryData<Kiosk[]>(kiosksKey(pid), (l = []) => l.map((x) => (x.id === k.id ? k : x))),
  });
}
export function useDeleteKiosk(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/kiosks/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: kiosksKey(pid) });
      qc.setQueryData<Kiosk[]>(kiosksKey(pid), (l) => l?.filter((x) => x.id !== id));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: kiosksKey(pid) }),
  });
}

// ---------- session recordings ----------
export function useRecordings(pid: string, r: TimeRange, f: RecordingFilters = {}) {
  return useInfiniteQuery({
    queryKey: ['recordings', pid, r.from, r.to, f],
    queryFn: ({ pageParam, signal }) => api<RecordingsResponse>(`${base(pid)}/recordings`, { params: { from: r.from, to: r.to, limit: 50, before: pageParam, ...f }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextBefore ?? undefined,
    staleTime: STALE, placeholderData: keepPreviousData,
  });
}
/** A whole recording: the API sends it in parts of a few MB, fetched one after another. */
export function useRecording(pid: string, sessionId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['recording', pid, sessionId],
    queryFn: async ({ signal }) => {
      const first = await api<RecordingResponse>(`${base(pid)}/recordings/${encodeURIComponent(sessionId)}`, { signal });
      let next = first.nextAfter;
      for (let i = 0; next && i < 40; i++) {
        const page = await api<RecordingResponse>(`${base(pid)}/recordings/${encodeURIComponent(sessionId)}`, { params: { after: next }, signal });
        first.chunks.push(...page.chunks);
        next = page.nextAfter;
      }
      return { ...first, nextAfter: next };
    },
    staleTime: 60_000, retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2,
  });
}
export const useRecordingSettings = (pid: string) =>
  useQuery({ queryKey: ['recording-settings', pid], queryFn: () => api<RecordingSettingsResponse>(`${base(pid)}/recording-settings`), staleTime: 15_000 });
export function useSaveRecordingSettings(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: RecordingSettings) => api<RecordingSettingsResponse>(`${base(pid)}/recording-settings`, { method: 'PATCH', body: s }),
    onSuccess: (r) => qc.setQueryData(['recording-settings', pid], r),
  });
}

// ---------- uptime checks ----------
const uptimeKey = (pid: string) => ['uptime', pid] as const;

export const useUptime = (pid: string, r: TimeRange, enabled = true) =>
  useQuery({
    enabled,
    queryKey: [...uptimeKey(pid), r.from, r.to] as const,
    queryFn: ({ signal }) => api<UptimeCheck[]>(`${base(pid)}/uptime`, { params: rp(r), signal }),
    staleTime: 15_000, placeholderData: keepPreviousData, refetchInterval: 60_000,
  });
export const useUptimeResults = (pid: string, id: string | null, r: TimeRange) =>
  useQuery({
    queryKey: ['uptime-results', pid, id, r.from, r.to] as const,
    queryFn: ({ signal }) => api<UptimeResults>(`${base(pid)}/uptime/${id}/results`, { params: rp(r), signal }),
    enabled: !!id, staleTime: 15_000, placeholderData: keepPreviousData,
  });
export function useSaveUptime(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<UptimeCheckInput> }) =>
      id ? api<UptimeCheck>(`${base(pid)}/uptime/${id}`, { method: 'PATCH', body: input }) : api<UptimeCheck>(`${base(pid)}/uptime`, { method: 'POST', body: input }),
    onSettled: () => qc.invalidateQueries({ queryKey: uptimeKey(pid) }),
  });
}
export function useDeleteUptime(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/uptime/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: uptimeKey(pid) }),
  });
}
export function useRunUptime(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<UptimeRunResult>(`${base(pid)}/uptime/${id}/run`, { method: 'POST' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: uptimeKey(pid) }); void qc.invalidateQueries({ queryKey: ['uptime-results', pid] }); },
  });
}

// ---------- budgets ----------
const budgetsKey = ['budgets'] as const;
export const useBudgets = () => useQuery({ queryKey: budgetsKey, queryFn: () => api<Budget[]>('/api/costs/budgets'), staleTime: 30_000, retry: false });
export function useSaveBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<BudgetInput> }) =>
      id ? api<Budget>(`/api/costs/budgets/${id}`, { method: 'PATCH', body: input }) : api<Budget>('/api/costs/budgets', { method: 'POST', body: input }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: budgetsKey }); void qc.invalidateQueries({ queryKey: ['collection'] }); },
  });
}
export function useDeleteBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/costs/budgets/${id}`, { method: 'DELETE' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: budgetsKey }); void qc.invalidateQueries({ queryKey: ['collection'] }); },
  });
}
export function useResumeBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Budget>(`/api/costs/budgets/${id}/resume`, { method: 'POST' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: budgetsKey }); void qc.invalidateQueries({ queryKey: ['collection'] }); },
  });
}
/** Whether a cost budget stopped collecting this project's data. */
export const useCollection = (pid: string) =>
  useQuery({ queryKey: ['collection', pid] as const, queryFn: () => api<{ paused: boolean }>(`${base(pid)}/collection`), staleTime: 60_000, retry: false });

// ---------- the project's public website (All projects page) ----------
export const useSite = (pid: string) =>
  useQuery({ queryKey: ['site', pid] as const, queryFn: () => api<ProjectSite>(`${base(pid)}/site`), staleTime: 10 * 60_000, retry: false });

/** The homepage screenshot of `day`. A new one is taken at most once a day, so it's kept in localStorage per day. */
export function useSiteImage(pid: string, day: string | null) {
  return useQuery({
    queryKey: ['site-image', pid, day] as const,
    enabled: !!day,
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const key = `wgo.site.${pid}`;
      try {
        const hit = JSON.parse(localStorage.getItem(key) ?? 'null') as { day: string; image: string } | null;
        if (hit?.day === day) return hit.image;
      } catch { /* fetch it */ }
      const { image } = await api<{ image: string }>(`${base(pid)}/site/image`, { params: { day: day! }, signal });
      try { localStorage.setItem(key, JSON.stringify({ day, image })); } catch { /* storage full: still shown */ }
      return image;
    },
  });
}

// ---------- what the install costs ----------
export const useCosts = (pid: string) =>
  useQuery({ queryKey: ['costs', pid] as const, queryFn: () => api<CostsResponse>('/api/costs', { params: { pid } }), staleTime: 5 * 60_000, retry: false });

// ---------- custom dashboards ----------
const dashboardsKey = (pid: string) => ['dashboards', pid] as const;
const dashboardKey = (pid: string, id: string) => ['dashboard', pid, id] as const;
export const useDashboards = (pid: string, enabled = true) =>
  useQuery({ queryKey: dashboardsKey(pid), queryFn: () => api<DashboardSummary[]>(`${base(pid)}/dashboards`), staleTime: 30_000, enabled });
/** A kiosk screen polls it, so a member's edits show up on the wall. */
export const useDashboard = (pid: string, id: string, poll?: number, enabled = true) =>
  useQuery({ queryKey: dashboardKey(pid, id), queryFn: () => api<Dashboard>(`${base(pid)}/dashboards/${id}`), staleTime: 30_000, refetchInterval: poll, enabled: enabled && !!id });
export function useCreateDashboard(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DashboardInput) => api<Dashboard>(`${base(pid)}/dashboards`, { method: 'POST', body: input }),
    onSuccess: (d) => qc.setQueryData(dashboardKey(pid, d.id), d),
    onSettled: () => qc.invalidateQueries({ queryKey: dashboardsKey(pid) }),
  });
}
export function useUpdateDashboard(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<DashboardInput> }) => api<Dashboard>(`${base(pid)}/dashboards/${id}`, { method: 'PATCH', body: input }),
    onSuccess: (d) => qc.setQueryData(dashboardKey(pid, d.id), d),
    onSettled: () => qc.invalidateQueries({ queryKey: dashboardsKey(pid) }),
  });
}
export function useDuplicateDashboard(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Dashboard>(`${base(pid)}/dashboards/${id}/duplicate`, { method: 'POST' }),
    onSuccess: (d) => qc.setQueryData(dashboardKey(pid, d.id), d),
    onSettled: () => qc.invalidateQueries({ queryKey: dashboardsKey(pid) }),
  });
}
export function useDeleteDashboard(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/dashboards/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: dashboardsKey(pid) });
      qc.setQueryData<DashboardSummary[]>(dashboardsKey(pid), (cur) => cur?.filter((d) => d.id !== id));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: dashboardsKey(pid) }),
  });
}
/** Add one tile below the others ("Add to dashboard"). */
export function useAddTile(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tile }: { id: string; tile: Partial<DashboardTile> }) => api<Dashboard>(`${base(pid)}/dashboards/${id}/tiles`, { method: 'POST', body: tile }),
    onSuccess: (d) => qc.setQueryData(dashboardKey(pid, d.id), d),
    onSettled: () => qc.invalidateQueries({ queryKey: dashboardsKey(pid) }),
  });
}
/** Names for the measure picker: tracked clicks, custom events and OpenTelemetry metrics seen in the last 7 days. */
export const useMeasureNames = (pid: string) =>
  useQuery({ queryKey: ['measures', pid], queryFn: () => api<MeasureNames>(`${base(pid)}/measures`), staleTime: 5 * 60_000 });
/** One generic query (a dashboard tile). `filters` are the dashboard-wide events filters. */
export const useQueryResult = (pid: string, r: Pick<TimeRange, 'from' | 'to'>, spec: QuerySpec | null, filters: string | undefined, traffic: { bots?: string; dev?: string } | undefined, enabled = true) =>
  useQuery({
    queryKey: ['query', pid, r.from, r.to, spec, filters, traffic],
    queryFn: ({ signal }) => api<QueryResult>(`${base(pid)}/query`, { params: { ...rp(r), q: JSON.stringify(spec), filters, ...traffic }, signal }),
    staleTime: STALE, placeholderData: keepPreviousData, enabled: enabled && !!spec,
  });

// ---------- GitHub Agent (only shown when an admin turned it on: Me.features.fixAgent) ----------
export const useGithubApp = (enabled = true) =>
  useQuery({ queryKey: ['github-app'] as const, queryFn: () => api<GithubAppStatus>('/api/github'), enabled, staleTime: 60_000 });
export const githubManifest = (pid: string, org?: string) => api<GithubManifestForm>('/api/github/manifest', { params: { pid, org } });
export const githubInstallUrl = (pid: string) => api<{ url: string }>(`${base(pid)}/fix-settings/install-url`).then((r) => r.url);
export const useFixSettings = (pid: string, enabled = true) =>
  useQuery({ queryKey: ['fix-settings', pid] as const, queryFn: () => api<FixSettings>(`${base(pid)}/fix-settings`), enabled, staleTime: 30_000 });
export const useGithubRepos = (pid: string, enabled: boolean) =>
  useQuery({ queryKey: ['github-repos', pid] as const, queryFn: () => api<GithubRepo[]>(`${base(pid)}/fix-settings/repos`), enabled, staleTime: 60_000, retry: false });
export function useSaveFixSettings(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<FixSettingsInput>) => api<FixSettings>(`${base(pid)}/fix-settings`, { method: 'PATCH', body: input }),
    onSuccess: (s) => qc.setQueryData(['fix-settings', pid], s),
  });
}
const LIVE_RUN = (runs: FixRun[] | undefined) => !!runs?.some((r) => r.status === 'queued' || r.status === 'running');
/** Every 3 s while a run is going, every minute while its pull request is open (to see it merged), else not at all. */
const runsPoll = (runs: FixRun[] | undefined) => (LIVE_RUN(runs) ? 3_000 : runs?.some((r) => r.prState === 'open') ? 60_000 : false);
/** A project's runs (or one error group's), polled while one is going or its pull request is open. */
export const useFixRuns = (pid: string, fingerprint: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ['fix-runs', pid, fingerprint ?? null] as const,
    queryFn: () => api<FixRun[]>(`${base(pid)}/fixes`, { params: { fingerprint, limit: fingerprint ? 10 : 20 } }),
    enabled, staleTime: 5_000,
    refetchInterval: (q) => runsPoll(q.state.data),
  });
/** The pull requests the GitHub Agent opened in a project, newest first (Pull requests page and its menu count). */
export const usePullRequests = (pid: string, enabled = true) =>
  useQuery({
    queryKey: ['fix-runs', pid, 'prs'] as const,
    queryFn: () => api<FixRun[]>(`${base(pid)}/fixes`, { params: { pr: 1, limit: 100 } }),
    enabled, staleTime: 30_000, refetchInterval: 60_000, refetchOnMount: 'always',
  });
export function useStartFix(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: Record<string, unknown>) => api<FixRun>(`${base(pid)}/fixes`, { method: 'POST', body: b }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['fix-runs', pid] }); void qc.invalidateQueries({ queryKey: ['errors', pid] }); void qc.invalidateQueries({ queryKey: ['fix-settings', pid] }); },
  });
}
export function useCancelFix(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<FixRun>(`${base(pid)}/fixes/${id}/cancel`, { method: 'POST' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['fix-runs', pid] }); void qc.invalidateQueries({ queryKey: ['errors', pid] }); },
  });
}

/** The GitHub Agent's model for every project (admins). */
export const useFixAgentAdmin = (enabled = true) =>
  useQuery({ queryKey: ['fix-agent-admin'] as const, queryFn: () => api<FixAgentAdmin>('/api/fix-agent'), enabled, staleTime: 30_000, retry: false });
export function useSaveFixAgentAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<FixAgentConfigInput>) => api<FixAgentAdmin>('/api/fix-agent', { method: 'PATCH', body: input }),
    onSuccess: (d) => { qc.setQueryData(['fix-agent-admin'], d); void qc.invalidateQueries({ queryKey: ['fix-settings'] }); void qc.invalidateQueries({ queryKey: keys.me }); },
  });
}
/** The backend error a span or log stands for and its runs, polled like useFixRuns. */
export const useFixTarget = (pid: string, t: Exclude<FixTarget, { kind: 'browser' }>, enabled: boolean) =>
  useQuery({
    queryKey: ['fix-runs', pid, 'for', t] as const,
    queryFn: () => api<FixTargetInfo>(`${base(pid)}/fixes/for`, { params: { ...t } }),
    enabled, staleTime: 5_000, retry: false,
    refetchInterval: (q) => runsPoll(q.state.data?.runs),
  });

// ---------- install-wide switches (admins turn them on in the dashboard) ----------
const NO_FEATURES: InstallFeatures = { fixAgent: false, mcp: false, slackApp: false };
/** What admins turned on for the whole install. */
export const useFeatures = (): InstallFeatures => useMe().data?.features ?? NO_FEATURES;
export const useInstall = (enabled = true) =>
  useQuery({ queryKey: ['install'] as const, queryFn: () => api<InstallSettings>('/api/install'), enabled, staleTime: 30_000, retry: false });
function useInstallMutation<T>(fn: (b: T) => Promise<InstallSettings>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (d) => { qc.setQueryData(['install'], d); void qc.invalidateQueries({ queryKey: keys.me }); void qc.invalidateQueries({ queryKey: ['slack-setup'] }); },
  });
}
export const useSetMcp = () => useInstallMutation((enabled: boolean) => api<InstallSettings>('/api/install/mcp', { method: 'PATCH', body: { enabled } }));
export const useSetSlackApp = () => useInstallMutation((b: { clientId: string; clientSecret?: string }) => api<InstallSettings>('/api/install/slack', { method: 'PUT', body: b }));
export const useDeleteSlackApp = () => useInstallMutation((_: void) => api<InstallSettings>('/api/install/slack', { method: 'DELETE' }));

// ---------- SQL editor ----------
export const useSqlSchema = (pid: string) =>
  useQuery({ queryKey: ['sql-schema', pid], queryFn: ({ signal }) => api<SqlSchema>(`${base(pid)}/sql/schema`, { signal }), staleTime: Infinity });
export const runSql = (pid: string, req: SqlRequest, signal?: AbortSignal) => api<SqlResult>(`${base(pid)}/sql`, { method: 'POST', body: req, signal });
export const exportSql = (pid: string, req: SqlExportRequest, signal?: AbortSignal) => api<SqlExport>(`${base(pid)}/sql/export`, { method: 'POST', body: req, signal });
/**
 * Data of a SQL tile. Members run its query (so an edit shows before it's saved); a kiosk asks for the saved tile's
 * data by id (`saved`), as kiosks can't run SQL of their own.
 */
export const useSqlTile = (pid: string, r: Pick<TimeRange, 'from' | 'to'>, query: string | null, saved: { dashboardId: string; tileId: string } | null) =>
  useQuery({
    queryKey: ['sql-tile', pid, r.from, r.to, query, saved?.dashboardId, saved?.tileId],
    queryFn: ({ signal }) => saved
      ? api<SqlResult>(`${base(pid)}/dashboards/${saved.dashboardId}/tiles/${saved.tileId}/data`, { params: rp(r), signal })
      : runSql(pid, { sql: query!, from: r.from, to: r.to, limit: 5000 }, signal),
    staleTime: STALE, placeholderData: keepPreviousData, enabled: !!query, retry: false,
  });

// ---------- surveys ----------
const surveysKey = (pid: string) => ['surveys', pid] as const;
export const useSurveys = (pid: string) =>
  useQuery({ queryKey: surveysKey(pid), queryFn: () => api<Survey[]>(`${base(pid)}/surveys`), staleTime: 30_000 });
export const useSurvey = (pid: string, id: string | null) =>
  useQuery({ queryKey: [...surveysKey(pid), id] as const, queryFn: () => api<Survey>(`${base(pid)}/surveys/${id}`), staleTime: 30_000, enabled: !!id });
export const useSurveyResults = (pid: string, id: string, r: TimeRange) =>
  useQuery({
    queryKey: ['survey-results', pid, id, r.from, r.to] as const,
    queryFn: ({ signal }) => api<SurveyResults>(`${base(pid)}/surveys/${id}/results`, { params: rp(r), signal }),
    staleTime: STALE, placeholderData: keepPreviousData,
  });
export const useSurveyResponses = (pid: string, id: string, r: TimeRange) =>
  useInfiniteQuery({
    queryKey: ['survey-responses', pid, id, r.from, r.to] as const,
    queryFn: ({ pageParam, signal }) => api<SurveyResponsesPage>(`${base(pid)}/surveys/${id}/responses`, { params: { ...rp(r), before: pageParam || undefined, limit: 50 }, signal }),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    staleTime: STALE,
  });
/** Every response in the range (for the CSV export), page by page. */
export async function fetchAllSurveyResponses(pid: string, id: string, r: Pick<TimeRange, 'from' | 'to'>, max = 50_000): Promise<SurveyResponse[]> {
  const out: SurveyResponse[] = [];
  let before: string | null = '';
  while (before !== null && out.length < max) {
    const page: SurveyResponsesPage = await api<SurveyResponsesPage>(`${base(pid)}/surveys/${id}/responses`, { params: { ...rp(r), before: before || undefined, limit: 1000 } });
    out.push(...page.responses);
    before = page.next;
  }
  return out;
}
const invalidateSurveys = (qc: QueryClient, pid: string) =>
  Promise.all([qc.invalidateQueries({ queryKey: surveysKey(pid) }), qc.invalidateQueries({ queryKey: ['survey-results', pid] })]);
export function useSaveSurvey(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<SurveyInput> }) =>
      id ? api<Survey>(`${base(pid)}/surveys/${id}`, { method: 'PATCH', body: input }) : api<Survey>(`${base(pid)}/surveys`, { method: 'POST', body: input }),
    onSuccess: (s) => qc.setQueryData([...surveysKey(pid), s.id], s),
    onSettled: () => invalidateSurveys(qc, pid),
  });
}
export function useDeleteSurvey(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`${base(pid)}/surveys/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: surveysKey(pid) });
      qc.setQueryData<Survey[]>(surveysKey(pid), (cur) => cur?.filter((s) => s.id !== id));
    },
    onSettled: () => invalidateSurveys(qc, pid),
  });
}
