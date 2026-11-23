import { useState } from 'react';
import { LayoutGrid, Plus } from 'lucide-react';
import { useCreateDashboard, useDashboards } from '../api/hooks';
import { cn, relTime } from '../lib/format';
import { useProject } from '../lib/project';
import { navigate, pageHref, useRoute } from '../lib/router';
import { Button, Card, Dialog, EmptyState, ErrorState, Skeleton, useToast } from '../ui/kit';
import { TEMPLATES } from './templates';

/** All dashboards of the project. */
export function DashboardsPage() {
  const { project } = useProject();
  const route = useRoute();
  const list = useDashboards(project.id);
  const [creating, setCreating] = useState(false);

  if (list.isError) return <ErrorState error={list.error} retry={() => list.refetch()} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[640px] text-[13px] text-muted">Put any numbers side by side: traffic, conversions, errors, Web Vitals, your services’ latency and logs, OpenTelemetry metrics and uptime. Everyone in {project.name} sees the same dashboards.</p>
        <Button variant="primary" onClick={() => setCreating(true)}><Plus size={14} />New dashboard</Button>
      </div>
      {list.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[104px]" />)}</div>
      ) : !list.data?.length ? (
        <Card className="p-6">
          <EmptyState icon={<LayoutGrid size={22} />} title="No dashboards yet" action={<Button variant="primary" onClick={() => setCreating(true)}><Plus size={14} />Create your first dashboard</Button>}>
            Start from a template or from scratch. You can also add any chart you see in WGO to a dashboard with its “Add to dashboard” button.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.map((d) => (
            <a key={d.id} href={'#' + pageHref(project.id, `dashboards/${d.id}`, route.params)}>
              <Card hover className="h-full p-4">
                <div className="truncate text-[14px] font-semibold">{d.name}</div>
                <div className="mt-1 text-[12px] text-faint">{d.tiles} tile{d.tiles === 1 ? '' : 's'} · updated {relTime(d.updatedAt)}</div>
                <div className="mt-3 truncate text-[11.5px] text-faint">Created by {d.createdBy}</div>
              </Card>
            </a>))}
        </div>
      )}
      {creating && <NewDashboardDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

export function NewDashboardDialog({ onClose }: { onClose: () => void }) {
  const { project } = useProject();
  const route = useRoute();
  const toast = useToast();
  const create = useCreateDashboard(project.id);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('web');
  const tpl = TEMPLATES.find((x) => x.id === template)!;
  const submit = () => create.mutate({ name: name.trim() || (template === 'blank' ? 'My dashboard' : tpl.name), config: { tiles: tpl.tiles() } }, {
    onSuccess: (d) => { onClose(); navigate(pageHref(project.id, `dashboards/${d.id}`, route.params, template === 'blank' ? { add: '1' } : {})); },
    onError: (e) => toast({ title: 'Could not create the dashboard', body: (e as Error).message, tone: 'bad' }),
  });
  return (
    <Dialog open onClose={onClose} width={560} title="New dashboard"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={create.isPending} onClick={submit}>Create</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-4">
        <label className="block"><span className="mb-1 block text-[11.5px] font-medium text-muted">Name</span>
          <input autoFocus className="field" value={name} maxLength={120} placeholder={template === 'blank' ? 'My dashboard' : tpl.name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <span className="mb-1.5 block text-[11.5px] font-medium text-muted">Start from</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {TEMPLATES.map((x) => (
              <button type="button" key={x.id} onClick={() => setTemplate(x.id)}
                className={cn('rounded-xl border p-3 text-left transition-colors cursor-pointer', template === x.id ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-[var(--line-strong)]')}>
                <div className="text-[13px] font-semibold">{x.name}</div>
                <div className="mt-0.5 text-[12px] text-muted">{x.description}</div>
              </button>))}
          </div>
        </div>
      </form>
    </Dialog>
  );
}
