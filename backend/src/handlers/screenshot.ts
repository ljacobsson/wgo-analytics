import type { Context } from 'aws-lambda';
import { openBrowser } from '../lib/screenshot';
import { runScreenshots } from '../lib/sites';

/**
 * Scheduled every 15 minutes (one run at a time): a screenshot of each project's public homepage, at most once a day
 * per project (lib/sites.ts). With nothing due it costs one query and never starts the browser.
 */
export async function handler(_event: unknown, context: Context): Promise<{ shot: number; failed: number }> {
  const deadline = Date.now() + Math.min(context.getRemainingTimeInMillis() - 60_000, 4 * 60_000);
  const result = await runScreenshots(deadline, openBrowser);
  if (result.shot || result.failed) console.log(JSON.stringify(result));
  return result;
}
