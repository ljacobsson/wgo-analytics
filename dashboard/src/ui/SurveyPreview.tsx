import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { SurveyInput } from '../api/contract';
// the SDK's own renderer: the preview is exactly what visitors get
import { render } from '../../../sdk/src/surveys/render';
import { cn } from '../lib/format';
import { Segmented } from './kit';

/**
 * A survey as the SDK draws it, in a mock browser window: a floating card in its corner, or inline inside a page
 * section standing in for the element its selector names. `step` jumps to a question (steps layout).
 */
export function SurveyPreview({ survey, step, path }: { survey: SurveyInput; step: number; path?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  const [run, setRun] = useState(0);
  const [closed, setClosed] = useState(false);
  const inline = survey.display.mode === 'inline';
  const dark = survey.display.theme === 'auto' ? scheme === 'dark' : survey.display.theme === 'dark';

  useEffect(() => { setClosed(false); }, [survey, step]);
  useEffect(() => {
    const el = host.current;
    if (!el || closed || !survey.questions.length) { if (el?.shadowRoot) el.shadowRoot.textContent = ''; return; }
    // the editor allows unfinished questions; give them something to draw
    const questions = survey.questions.map((q, i) => ({
      ...q,
      title: q.title.trim() || `Question ${i + 1}`,
      options: q.options?.map((o, j) => o.trim() || `Option ${j + 1}`),
    }));
    const display = { ...survey.display, theme: survey.display.theme === 'auto' ? scheme : survey.display.theme };
    try {
      return render(el, { id: 'preview', name: survey.name || 'Survey', questions, display, targeting: survey.targeting }, {
        fixed: false, step, onSubmit: () => {}, onDismiss: () => setClosed(true), onDone: () => setClosed(true),
      });
    } catch {
      return undefined;
    }
  }, [survey, step, scheme, run, closed]);

  const page = dark ? 'bg-[#0f0f12]' : 'bg-[#f6f6f7]';
  const block = dark ? 'bg-white/[.06]' : 'bg-black/[.06]';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-muted">Preview</span>
        <div className="flex items-center gap-1.5">
          {(closed || survey.display.mode === 'popover') && (
            <button onClick={() => { setClosed(false); setRun((n) => n + 1); }} title="Show it again from the start" className="rounded-md p-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg cursor-pointer"><RotateCcw size={13} /></button>
          )}
          {survey.display.theme === 'auto' && <Segmented value={scheme} onChange={setScheme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-line shadow-sm">
        <div className={cn('flex items-center gap-2 border-b px-3 py-2', dark ? 'border-white/10 bg-[#1b1b20]' : 'border-black/10 bg-white')}>
          <span className="flex gap-1">{[0, 1, 2].map((i) => <i key={i} className={cn('h-2.5 w-2.5 rounded-full', dark ? 'bg-white/15' : 'bg-black/15')} />)}</span>
          <span className={cn('ml-2 flex-1 truncate rounded-md px-2 py-0.5 font-mono text-[11px]', dark ? 'bg-white/[.06] text-white/50' : 'bg-black/[.05] text-black/50')}>yoursite.com{path || '/'}</span>
        </div>
        <div className={cn('relative min-h-[460px] p-6', page)}>
          <div className={cn('h-5 w-2/5 rounded', block)} />
          <div className={cn('mt-3 h-3 w-4/5 rounded', block)} />
          <div className={cn('mt-2 h-3 w-3/5 rounded', block)} />
          {inline ? (
            <div className="mt-6">
              <div className={cn('mb-1.5 font-mono text-[10.5px]', dark ? 'text-white/35' : 'text-black/35')}>{survey.display.selector || 'your element'}</div>
              <div className={cn('rounded-lg border border-dashed p-0', dark ? 'border-white/15' : 'border-black/15')}>
                <div ref={host} />
                {closed && <p className={cn('p-4 text-[12px]', dark ? 'text-white/40' : 'text-black/40')}>Submitted.</p>}
              </div>
            </div>
          ) : (
            <>
              <div className={cn('mt-6 h-28 rounded-lg', block)} />
              <div className={cn('mt-3 h-3 w-2/3 rounded', block)} />
              <div ref={host} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
