import { useState } from 'react';
import type { MissingSourcemaps } from '../api/contract';
import { getConfig } from '../api/config';
import { useProject } from '../lib/project';
import { pageHref, useRoute } from '../lib/router';
import { CodeBlock } from '../ui/CodeBlock';
import { CopyButton, Dialog, Mono } from '../ui/kit';
import { Steps } from './Mcp';

/** The prompt that sends Claude Code (or any MCP client in the app's repository) off to fix it. */
export function sourcemapPrompt(projectName: string, m: MissingSourcemaps): string {
  return `Build this app with source maps and upload them to the WGO project "${projectName}"${m.release ? ` for release ${m.release}` : ''}, then check that its errors show the original code.`;
}

/** "Source maps missing. Fix →" under a stack trace whose frames could not be mapped, and the dialog that explains the fix. */
export function SourcemapsMissing({ missing }: { missing: MissingSourcemaps }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="text-[12px] text-muted">
        Source maps missing.{' '}
        <button className="cursor-pointer text-accent hover:underline" onClick={() => setOpen(true)}>Fix →</button>
      </p>
      <SourcemapsDialog missing={missing} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function SourcemapsDialog({ missing, open, onClose }: { missing: MissingSourcemaps; open: boolean; onClose: () => void }) {
  const { project } = useProject(); const route = useRoute();
  const mcpUrl = getConfig().mcpUrl;
  const prompt = sourcemapPrompt(project.name, missing);
  const files = missing.files;
  const shown = files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', ');
  const settings = '#' + pageHref(project.id, 'settings', route.params);
  const mcp = '#' + pageHref(project.id, 'mcp', route.params);
  return (
    <Dialog open={open} onClose={onClose} width={600} title="Upload source maps">
      <div className="space-y-4 text-[13px] leading-relaxed text-muted">
        <p>
          This stack trace points at minified code. No source map was uploaded for <Mono className="text-fg">{shown}</Mono>
          {missing.release ? <> in release <Mono className="text-fg">{missing.release}</Mono></> : null}, so WGO can’t show your
          original files, lines and functions.
        </p>
        {mcpUrl ? (
          <>
            <p>The quickest fix is to let Claude Code do it from the app’s repository, through WGO’s MCP server:</p>
            <Steps items={[
              <>If WGO isn’t connected yet, add it from a terminal, then run <Mono>/mcp</Mono> in Claude Code and sign in:
                <CodeBlock lang="sh" code={`claude mcp add --transport http wgo ${mcpUrl}`} />
                <span className="block text-[12px]">Using another assistant? See <a className="text-accent hover:underline" href={mcp} onClick={onClose}>AI assistants (MCP)</a>.</span></>,
              <>In the app’s repository, ask:
                <div className="flex items-start gap-2 rounded-lg border border-line bg-[var(--hl)] px-3 py-2 text-fg">
                  <span className="min-w-0 flex-1">{prompt}</span><CopyButton text={prompt} />
                </div></>,
              <>Claude finds the release your app reports, builds it with hidden source maps and uploads them with the <Mono>upload_sourcemaps</Mono> tool.
                Stacks are mapped when you view them, so errors that already happened show your code too.</>,
            ]} />
          </>
        ) : (
          <p>MCP is turned off on this WGO, so upload the maps from your build with the <Mono>wgo-sourcemaps</Mono> command.</p>
        )}
        <p className="border-t border-line pt-3 text-[12.5px]">
          To upload them on every deploy, run the upload command in CI with the project’s upload key. Owners find both under{' '}
          <a className="text-accent hover:underline" href={settings} onClick={onClose}>Settings, Source maps</a>.
        </p>
      </div>
    </Dialog>
  );
}
