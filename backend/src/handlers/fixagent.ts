import { runFixAgent } from '../lib/fixAgent/agent';

/** Invoked asynchronously by lib/fixes.ts startRun with one queued run; never retried (MaximumRetryAttempts 0). */
export async function handler(req: { projectId: string; runId: string }): Promise<{ ok: true }> {
  await runFixAgent(req.projectId, req.runId);
  return { ok: true };
}
