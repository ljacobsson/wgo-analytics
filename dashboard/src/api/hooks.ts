import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  Device, DeviceCreated, Kiosk, KioskConfig,
  BreakdownRow, ClickRow, ErrorGroup, EventsResponse, GeoResponse, HttpErrorGroup, LogsResponse, Me, Member, MetricInfo,
  MetricSeriesResponse, PageRow, Project, ServiceRow, StatsResponse, Totals, TraceResponse, TraceSummary, VitalsResponse, FieldsResponse, FieldValuesResponse, FilterScope, SlackIntegration, Trigger, TriggerInput, TriggerTestResult, SlackSetup,
  SavedView, SavedViewInput, Goal, GoalInput, GoalStep, GoalFunnel, ConversionsResponse, ClickAlias,
  RecordingsResponse, RecordingResponse, RecordingSettings, RecordingSettingsResponse, RecordingFilters,
} from './contract';
import { previousWindow, type TimeRange } from '../lib/time';
import { botsParam, filtersParam } from '../lib/filters';

const STALE = 20_000;
const base = (pid: string) => `/api/projects/${pid}`;
const rp = (r: TimeRange) => ({ from: r.from, to: r.to });

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
  stats: 'events', totals: 'events', clicks: 'events', pages: 'events', errors: 'events', 'http-errors': 'events', breakdown: 'events',
  vitals: 'events', geo: 'events', conversions: 'events', services: 'spans', traces: 'spans',
};

function q<T>(pid: string, name: string, r: TimeRange, path: string, extra: Record<string, string | number | boolean | undefined> = {}, enabled = true) {
  const scope = SCOPE[name];
  const params = scope ? { ...extra, filters: filtersParam(scope), ...(scope === 'events' ? { bots: botsParam() } : {}) } : extra;
  return {
    queryKey: [name, pid, r.from, r.to, params] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => api<T>(`${base(pid)}/${path}`, { params: { ...rp(r), ...params }, signal }),
    staleTime: STALE, placeholderData: keepPreviousData, enabled,
  };
}
// the comparison window comes from usePreviousTotals, which refreshes far less often
export const useStats = (pid: string, r: TimeRange) => useQuery(q<StatsResponse>(pid, 'stats', r, 'stats', { compare: 0 }));
export function usePreviousTotals(pid: string, r: TimeRange) {
  const w = previousWindow(r);
  return useQuery({ ...q<Totals>(pid, 'totals', { ...r, ...w }, 'totals'), queryKey: ['totals', pid, w.from, w.to, filtersParam('events'), botsParam()] as const, staleTime: 10 * 60_000 });
}
export const useClicks = (pid: string, r: TimeRange) => useQuery(q<ClickRow[]>(pid, 'clicks', r, 'clicks', { limit: 100 }));
export const usePages = (pid: string, r: TimeRange) => useQuery(q<PageRow[]>(pid, 'pages', r, 'pages', { limit: 10 }));
export const useErrors = (pid: string, r: TimeRange) => useQuery(q<ErrorGroup[]>(pid, 'errors', r, 'errors', { limit: 100 }));
export const useHttpErrors = (pid: string, r: TimeRange) => useQuery(q<HttpErrorGroup[]>(pid, 'http-errors', r, 'http-errors', { limit: 100 }));
export const useBreakdown = (pid: string, r: TimeRange, dim: string) => useQuery(q<BreakdownRow[]>(pid, 'breakdown', r, 'breakdown', { dim }));
export const useVitals = (pid: string, r: TimeRange) => useQuery(q<VitalsResponse>(pid, 'vitals', r, 'vitals'));
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
export const useServices = (pid: string, r: TimeRange) => useQuery(q<ServiceRow[]>(pid, 'services', r, 'services'));
export const useMetrics = (pid: string, r: TimeRange) => useQuery(q<MetricInfo[]>(pid, 'metrics', r, 'metrics'));
export const useMetricSeries = (pid: string, r: TimeRange, name: string | null, agg: string, groupBy: string) =>
  useQuery(q<MetricSeriesResponse>(pid, 'metric-series', r, 'metrics/series', { name: name ?? '', agg, groupBy: groupBy || undefined }, !!name));
export const useTraces = (pid: string, r: TimeRange, f: { service?: string; minDurationMs?: number; errorsOnly?: boolean; q?: string }) =>
  useQuery(q<TraceSummary[]>(pid, 'traces', r, 'traces', { limit: 200, ...f }));
/** `at`: any time within the trace (its start, a log record's time), so the API looks in the right day first */
export const useTrace = (pid: string, traceId: string | null, at?: string | null) =>
  useQuery({ queryKey: ['trace', pid, traceId], queryFn: () => api<TraceResponse>(`${base(pid)}/traces/${traceId}`, { params: at ? { at } : {} }), enabled: !!traceId, staleTime: 5 * 60_000 });

export function useEvents(pid: string, r: TimeRange, base_: { type?: string; q?: string; sessionId?: string; fingerprint?: string }, enabled = true, limit = 100) {
  const f = { ...base_, filters: filtersParam('events'), bots: botsParam() };
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
export function useRotateKey(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<Project>(`/api/projects/${pid}/rotate-key`, { method: 'POST' }),
    onSuccess: (p) => qc.setQueryData<Me>(keys.me, (m) => m && { ...m, projects: m.projects.map((x) => (x.id === pid ? p : x)) }),
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

export const useFields = (pid: string, r: TimeRange, scope: FilterScope, enabled = true) =>
  useQuery({
    queryKey: ['fields', pid, scope, r.from, r.to],
    queryFn: ({ signal }) => api<FieldsResponse>(`${base(pid)}/fields`, { params: { ...rp(r), scope }, signal }),
    staleTime: 5 * 60_000, enabled,
  });
export const useFieldValues = (pid: string, r: TimeRange, scope: FilterScope, field: string, q: string, enabled = true) =>
  useQuery({
    queryKey: ['field-values', pid, scope, field, q, r.from, r.to],
    queryFn: ({ signal }) => api<FieldValuesResponse>(`${base(pid)}/fields/values`, { params: { ...rp(r), scope, field, q: q || undefined }, signal }),
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
export function useTestTrigger(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<TriggerTestResult>(`${base(pid)}/triggers/${id}/test`, { method: 'POST' }),
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
/** One click: fetch the signed "Add to Slack" URL and go there; Slack sends the user back to Triggers. */
export async function startSlackInstall(pid: string): Promise<void> {
  const { url } = await api<{ url: string }>(`${base(pid)}/slack/install`);
  window.location.assign(url);
}

const slackKey = (pid: string) => ['slack-setup', pid] as const;
export const useSlackSetup = (pid: string) =>
  useQuery({ queryKey: slackKey(pid), queryFn: () => api<SlackSetup>(`${base(pid)}/slack`), staleTime: 60_000 });
export function useSaveSlackApp(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (creds: { clientId: string; clientSecret: string }) => api<SlackSetup>(`${base(pid)}/slack/app`, { method: 'POST', body: creds }),
    onSuccess: (data) => qc.setQueryData(slackKey(pid), data),
  });
}
export function useRemoveSlackApp(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<SlackSetup>(`${base(pid)}/slack/app`, { method: 'DELETE' }),
    onSuccess: (data) => qc.setQueryData(slackKey(pid), data),
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
export function useRecording(pid: string, sessionId: string) {
  return useQuery({
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
