import { runChecks } from '../lib/uptime';

/**
 * Scheduled every minute (one run at a time): fetches the uptime checks that are due. With no enabled checks
 * it costs a single cheap query.
 */
export async function handler(): Promise<{ ran: number }> {
  const ran = await runChecks();
  if (ran) console.log(JSON.stringify({ ran }));
  return { ran };
}
