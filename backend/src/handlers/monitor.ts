import { runMonitor } from '../lib/monitor';

/**
 * Scheduled every minute: evaluates threshold and anomaly triggers. With none enabled it costs one small DSQL query,
 * so an idle install stays close to free.
 */
export async function handler(): Promise<object> {
  const result = await runMonitor();
  if (result.evaluated || result.failed) console.log(JSON.stringify(result));
  return result;
}
