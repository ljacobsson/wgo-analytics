import type { Context } from 'aws-lambda';
import { checkBudgets } from '../lib/budgets';
import { reportCluster } from '../lib/cluster';
import { purgeDeletedProjects } from '../lib/purge';
import { runRetention } from '../lib/retention';
import { detectSites } from '../lib/sites';
import { runRerolls, runRollups } from '../lib/rollups';
import { moveLegacyRows, runCompaction } from '../lib/store/maintain';
import { runVisitorDays } from '../lib/visitors';

/**
 * Scheduled every 15 minutes (one at a time): moving raw rows left in DSQL by older versions into Parquet
 * (until there are none), removing the data of deleted projects, merging small Parquet files, hourly rollups,
 * hourly cluster metrics, daily retention.
 * Each step resumes where it stopped, so a run that hits its time budget simply continues next time.
 */
export async function handler(_event: unknown, context: Context): Promise<object> {
  const deadline = Date.now() + Math.min(context.getRemainingTimeInMillis() - 90_000, 12 * 60_000);
  const legacy = await moveLegacyRows(deadline);
  // data of deleted projects; usually nothing to do. Gets a share of the run so a big project can't starve the rest.
  const purge = await purgeDeletedProjects(Math.min(deadline, Date.now() + 3 * 60_000));
  // merging gets a share of the run, so rollups and retention always get time too
  const compaction = await runCompaction(Math.min(deadline, Date.now() + 4 * 60_000));
  const rollups = await runRollups(deadline);
  const cluster = await reportCluster().catch((err) => {
    console.warn('cluster metrics failed', err);
    return null;
  });
  // projects whose error suppression rules changed: recount their rolled hours that hold errors
  const rerolls = rollups.caughtUp ? await runRerolls(Math.min(deadline, Date.now() + 3 * 60_000), rollups.until) : null;
  // cost budgets: alerts and pausing collection (Cost Explorer is cached, so this asks AWS at most twice a day)
  const budgets = await checkBudgets().catch((err) => {
    console.warn('checking budgets failed', err);
    return null;
  });
  // per-visitor-per-day rows for retention cohorts, built from complete days; gets a share of the run
  const visitors = rollups.caughtUp ? await runVisitorDays(Math.min(deadline, Date.now() + 5 * 60_000), rollups.until) : null;
  // each project's public website, re-checked daily (ScreenshotFunction takes the homepage screenshots)
  const sites = await detectSites(Math.min(deadline, Date.now() + 2 * 60_000)).catch((err) => {
    console.warn('detecting sites failed', err);
    return null;
  });
  // raw events are only deleted after they are rolled up (and turned into visitor_days); retention waits until rollups have caught up
  const retention = rollups.caughtUp ? await runRetention(deadline, rollups.until, Date.now(), visitors?.until) : { done: false, deleted: {} };
  const result = { legacy, purge, compaction, rollups, rerolls, budgets, visitors, sites, cluster, retention };
  console.log(JSON.stringify(result));
  return result;
}
