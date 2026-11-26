import { autoSweep, sweepPrStates } from '../lib/fixes';
import { runMonitor } from '../lib/monitor';

/**
 * Scheduled every minute: evaluates threshold and anomaly triggers, starts automatic GitHub Agent runs (every five
 * minutes, for projects that turned them on) and checks whether its open pull requests were merged. With neither in use it costs two small DSQL queries, so an idle
 * install stays close to free.
 */
export async function handler(): Promise<object> {
  const [result, fixes] = await Promise.all([
    runMonitor(),
    autoSweep().catch((err) => {
      console.warn(JSON.stringify({ msg: 'GitHub Agent sweep failed', error: String(err) }));
      return { started: 0 };
    }),
    // merged or closed pull requests of the GitHub Agent
    sweepPrStates().catch((err) => console.warn(JSON.stringify({ msg: 'checking pull requests failed', error: String(err) }))),
  ]);
  if (result.evaluated || result.failed || fixes.started) console.log(JSON.stringify({ ...result, fixRunsStarted: fixes.started }));
  return { ...result, fixRunsStarted: fixes.started };
}
