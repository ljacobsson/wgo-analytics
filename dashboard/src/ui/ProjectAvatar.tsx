import type { Project } from '../api/contract';
import { useSite } from '../api/hooks';
import { cn } from '../lib/format';

/**
 * A project's avatar: its website's favicon (found with the daily homepage screenshot, lib/sites.ts) on a light
 * tile, since most favicons are drawn for light browser tabs; the first letter of the name until there is one.
 */
export function ProjectAvatar({ project, size = 'md' }: { project: Project; size?: 'sm' | 'md' }) {
  const site = useSite(project.id);
  const icon = site.data?.icon;
  const box = size === 'sm' ? 'h-7 w-7 rounded-lg' : 'h-9 w-9 rounded-xl';
  if (icon) {
    return (
      <span className={cn('grid shrink-0 place-items-center overflow-hidden border border-black/5 bg-white shadow-sm', box, size === 'sm' ? 'p-1' : 'p-1.5')}>
        <img src={icon} alt="" className="h-full w-full object-contain" />
      </span>
    );
  }
  return <span className={cn('grid shrink-0 place-items-center grad-bg font-bold text-white', box, size === 'sm' ? 'text-[12px]' : 'text-[14px]')}>{project.name.slice(0, 1).toUpperCase()}</span>;
}
