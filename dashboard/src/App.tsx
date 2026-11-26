import { useEffect, useState } from 'react';
import type { Project } from './api/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth/cognito';
import { AuthScreens } from './auth/AuthScreens';
import { useMe } from './api/hooks';
import { navigate, useRoute } from './lib/router';
import { ProjectCtx } from './lib/project';
import { Shell } from './shell/Shell';
import { Onboarding } from './pages/Onboarding';
import { LiveProvider } from './live/LiveProvider';
import { Skeleton, ErrorState, ToastProvider } from './ui/kit';
import { Overview } from './pages/Overview';
import { ProjectsPage } from './pages/Projects';
import { LivePage } from './pages/LivePage';
import { ClicksPage } from './pages/Clicks';
import { ErrorsPage } from './pages/Errors';
import { NetworkPage } from './pages/Network';
import { ReleasesPage } from './pages/Releases';
import { EventsPage } from './pages/Events';
import { RecordingsPage } from './pages/Recordings';
import { RecordingPlayerPage } from './pages/RecordingPlayer';
import { TriggersPage } from './pages/Triggers';
import { GoalsPage } from './pages/Goals';
import { RetentionPage } from './pages/Retention';
import { GoalFunnelPage } from './pages/GoalFunnel';
import { TracesPage } from './pages/Traces';
import { LogsPage } from './pages/Logs';
import { MetricsPage } from './pages/Metrics';
import { SettingsPage } from './pages/Settings';
import { WidgetPage } from './pages/Widget';
import { KiosksPage } from './pages/Kiosks';
import { UptimePage } from './pages/Uptime';
import { CostsPage } from './pages/Costs';
import { GithubAgentPage } from './pages/FixAgentAdmin';
import { McpPage } from './pages/Mcp';
import { OtelDocs } from './docs/OtelDocs';
import { Docs } from './docs/Docs';
import { DashboardsPage } from './dashboards/DashboardsPage';
import { DashboardPage } from './dashboards/DashboardPage';

function Authed({ email }: { email: string }) {
  const me = useMe();
  const route = useRoute();
  const [created, setCreated] = useState<Project | null>(null);
  const [seg0, pid, page = 'overview', sub] = route.segments;
  const projects = me.data?.projects ?? [];
  const project = projects.find((p) => p.id === pid);

  useEffect(() => {
    if (!me.data) return;
    if (seg0 === 'new' || created || !projects.length) return;
    if (seg0 === 'projects') return;
    // with several projects, land on the overview of all of them; with one, go straight in
    if (seg0 !== 'p' || !project) navigate(projects.length > 1 ? '/projects' : `/p/${projects[0].id}/overview`, true);
  }, [me.data, seg0, pid, project]); // eslint-disable-line react-hooks/exhaustive-deps

  if (me.isLoading) return <div className="bg-atmos h-full p-8"><Skeleton className="h-10 w-60" /><Skeleton className="mt-6 h-64" /></div>;
  if (me.isError) return <div className="bg-atmos h-full grid place-items-center"><ErrorState error={me.error} retry={() => me.refetch()} /></div>;
  if (!projects.length || seg0 === 'new' || created) {
    return <Onboarding first={!projects.length} project={created} setProject={setCreated} onBack={() => navigate(`/p/${projects[0].id}/overview`)}
      onDone={(p) => { setCreated(null); navigate(`/p/${p.id}/overview`); }} />;
  }
  if (seg0 === 'projects') return <ProjectsPage projects={projects} email={email} />;
  if (!project) return null;

  const body = (() => {
    switch (page) {
      case 'dashboards': return sub ? <DashboardPage id={sub} /> : <DashboardsPage />;
      case 'live': return <LivePage />;
      case 'clicks': return <ClicksPage />;
      case 'errors': return <ErrorsPage />;
      case 'network': return <NetworkPage />;
      case 'releases': return <ReleasesPage />;
      case 'events': return <EventsPage />;
      case 'recordings': return sub ? <RecordingPlayerPage sessionId={decodeURIComponent(sub)} /> : <RecordingsPage />;
      case 'goals': return sub ? <GoalFunnelPage goalId={sub} /> : <GoalsPage />;
      case 'retention': return <RetentionPage />;
      case 'triggers': return <TriggersPage />;
      case 'traces': return <TracesPage traceId={sub ?? null} />;
      case 'logs': return <LogsPage />;
      case 'metrics': return <MetricsPage />;
      case 'settings': return <SettingsPage />;
      case 'widget': return <WidgetPage />;
      case 'kiosks': return <KiosksPage />;
      case 'uptime': return <UptimePage />;
      case 'costs': return <CostsPage />;
      case 'fix-agent': return <GithubAgentPage />;
      case 'mcp': return <McpPage />;
      default: return <Overview />;
    }
  })();
  return (
    <ProjectCtx.Provider value={{ project, projects, email }}>
      <LiveProvider pid={project.id}>
        <Shell page={page}><div key={project.id}>{body}</div></Shell>
      </LiveProvider>
    </ProjectCtx.Provider>
  );
}

export default function App() {
  const auth = useAuth();
  const qc = useQueryClient();
  const route = useRoute();
  useEffect(() => { if (!auth.signedIn) qc.clear(); }, [auth.signedIn, qc]);
  // Public docs render the same whether or not you're signed in.
  if (route.segments[0] === 'docs') return <ToastProvider>{route.segments[1] === 'opentelemetry' ? <OtelDocs /> : <Docs />}</ToastProvider>;
  return <ToastProvider>{auth.signedIn ? <Authed email={auth.email ?? ''} /> : <AuthScreens />}</ToastProvider>;
}
