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
import tools.lars.wgo.data.AccountStore
import tools.lars.wgo.data.ApiException
import tools.lars.wgo.data.Settings
import tools.lars.wgo.data.WgoApi
import java.io.IOException
import java.util.concurrent.TimeUnit

object Refresher {
    /** Fetch fresh numbers for one widget and redraw it. Never throws. */
    suspend fun refresh(context: Context, id: GlanceId) {
        val config = WidgetStore.config(context, id) ?: return
        val account = AccountStore.get(context)
        if (account == null) {
            WidgetStore.updateData(context, id) { it.copy(refreshing = false, error = "Not connected", errorKind = "auth") }
            StatsWidget().update(context, id)
            return
        }
        WidgetStore.updateData(context, id) { it.copy(refreshing = true) }
        StatsWidget().update(context, id)
        val api = WgoApi(account)
        val result = runCatching {
            val now = System.currentTimeMillis()
            if (config.allProjects) WidgetData(overview = api.overview(config.range, config.stats), updatedAt = now)
            else WidgetData(summary = api.summary(config.projectId, config.range, config.stats), updatedAt = now)
        }
        WidgetStore.updateData(context, id) { old ->
            result.fold(
                onSuccess = { it },
                onFailure = { e ->
                    val kind = when {
                        e is ApiException && e.unauthorized -> "auth"
                        e is ApiException -> "other"
                        e is IOException -> "net"
                        else -> "other"
                    }
                    val message = if (kind == "net") "Offline" else e.message ?: "Refresh failed"
                    old.copy(refreshing = false, error = message, errorKind = kind)
                },
            )
        }
        StatsWidget().update(context, id)
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
