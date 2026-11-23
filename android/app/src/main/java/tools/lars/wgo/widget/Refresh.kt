package tools.lars.wgo.widget

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.action.ActionCallback
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import tools.lars.wgo.data.Account
import tools.lars.wgo.data.AccountStore
import tools.lars.wgo.data.ApiException
import tools.lars.wgo.data.Settings
import tools.lars.wgo.data.WgoApi
import tools.lars.wgo.data.WidgetOverview
import tools.lars.wgo.data.fetchOverviews
import tools.lars.wgo.data.mergeOverviews
import java.io.IOException
import java.util.concurrent.TimeUnit

object Refresher {
    /** Fetch fresh numbers for one widget and redraw it. Never throws. */
    suspend fun refresh(context: Context, id: GlanceId) {
        val config = WidgetStore.config(context, id) ?: return
        val accounts = AccountStore.resolve(context, config.accountId)
        if (accounts.isEmpty()) {
            WidgetStore.updateData(context, id) { it.copy(refreshing = false, error = "Not connected", errorKind = "auth") }
            StatsWidget().update(context, id)
            return
        }
        WidgetStore.updateData(context, id) { it.copy(refreshing = true) }
        StatsWidget().update(context, id)
        val now = System.currentTimeMillis()
        if (config.allProjects) {
            val results = fetchOverviews(accounts, config.range, config.stats)
            WidgetStore.updateData(context, id) { old -> overviewData(old, results, accounts, now) }
        } else {
            val result = runCatching { WgoApi(accounts.first()).summary(config.projectId, config.range, config.stats) }
            WidgetStore.updateData(context, id) { old ->
                result.fold(
                    onSuccess = { WidgetData(summary = it, updatedAt = now) },
                    onFailure = { e -> failure(e).let { (message, kind) -> old.copy(refreshing = false, error = message, errorKind = kind) } },
                )
            }
        }
        StatsWidget().update(context, id)
    }

    /** A user-facing message and kind (auth | net | other) for a failed request. */
    private fun failure(e: Throwable): Pair<String, String> {
        val kind = when {
            e is ApiException && e.unauthorized -> "auth"
            e is ApiException -> "other"
            e is IOException -> "net"
            else -> "other"
        }
        return (if (kind == "net") "Offline" else e.message ?: "Refresh failed") to kind
    }

    /**
     * Merges the accounts that answered. An account that failed keeps its previous rows, and the header names it,
     * so one deployment being down or disconnected doesn't blank out the others.
     */
    private fun overviewData(old: WidgetData, results: List<Pair<Account, Result<WidgetOverview>>>, accounts: List<Account>, now: Long): WidgetData {
        val multi = accounts.size > 1
        val failed = results.mapNotNull { (a, r) -> r.exceptionOrNull()?.let { a to failure(it) } }
        // with several accounts, name the one that failed; a revoked token there doesn't take over the whole widget
        val error = failed.firstOrNull()?.let { (a, f) ->
            if (!multi) f else "${AccountStore.label(a, accounts)}: ${if (f.second == "auth") "disconnected" else f.first}" to (if (f.second == "net") "net" else "other")
        }
        // nothing new: keep what's on screen
        if (failed.size == results.size) return old.copy(refreshing = false, error = error?.first, errorKind = error?.second)
        val fresh = results.mapNotNull { (a, r) -> r.getOrNull()?.let { a.id to it } }
        val stale = failed.mapNotNull { (a, _) ->
            val rows = old.overview?.projects?.filter { it.accountId == a.id }.orEmpty()
            old.overview?.takeIf { rows.isNotEmpty() }?.let { a.id to it.copy(projects = rows, total = rows.size) }
        }
        return WidgetData(overview = mergeOverviews(fresh + stale), updatedAt = now, error = error?.first, errorKind = error?.second)
    }

    suspend fun refreshAll(context: Context) {
        for (id in WidgetStore.glanceIds(context)) refresh(context, id)
    }
}

/** Background refresh. With an `appWidgetId` input it refreshes that widget, otherwise all of them. */
class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val appWidgetId = inputData.getInt(KEY_WIDGET, -1)
        if (appWidgetId == -1) Refresher.refreshAll(applicationContext)
        else WidgetStore.glanceId(applicationContext, appWidgetId)?.let { Refresher.refresh(applicationContext, it) }
        return Result.success()
    }

    companion object {
        const val KEY_WIDGET = "appWidgetId"
    }
}

object Scheduler {
    private const val PERIODIC = "wgo-periodic-refresh"

    /**
     * Android runs periodic background work at most every 15 minutes (and Doze may stretch that), so this
     * is the floor for unattended updates. Tapping refresh on the widget fetches immediately.
     */
    fun schedulePeriodic(context: Context, replace: Boolean = false) {
        val minutes = Settings.refreshMinutes(context).toLong()
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(minutes, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC,
            if (replace) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    fun cancelPeriodic(context: Context) = WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)

    /** Refresh one widget (or all, with null) as soon as possible. */
    fun refreshNow(context: Context, appWidgetId: Int? = null) {
        val request = OneTimeWorkRequestBuilder<RefreshWorker>()
            .setInputData(workDataOf(RefreshWorker.KEY_WIDGET to (appWidgetId ?: -1)))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("wgo-refresh-${appWidgetId ?: "all"}", ExistingWorkPolicy.REPLACE, request)
    }
}

/** The refresh button on the widget. */
class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        // show the spinner right away; the worker does the network call outside the broadcast's time limit
        WidgetStore.updateData(context, glanceId) { it.copy(refreshing = true) }
        StatsWidget().update(context, glanceId)
        Scheduler.refreshNow(context, GlanceAppWidgetManager(context).getAppWidgetId(glanceId))
    }
}
