package tools.lars.wgo.widget

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.state.PreferencesGlanceStateDefinition
import kotlinx.serialization.Serializable
import tools.lars.wgo.data.ALL_ACCOUNTS
import tools.lars.wgo.data.Account
import tools.lars.wgo.data.AccountStore
import tools.lars.wgo.data.ALL_PROJECTS
import tools.lars.wgo.data.WgoJson
import tools.lars.wgo.data.WidgetOverview
import tools.lars.wgo.data.WidgetSummary

/** Per-widget choices made in [tools.lars.wgo.ui.ConfigActivity]. */
@Serializable
data class WidgetConfig(
    /** a project id, or [ALL_PROJECTS] for an overview of every project */
    val projectId: String,
    val projectName: String,
    val stats: List<String>,
    val range: String = "24h",
    /** auto | dark | light | system (Material You) */
    val theme: String = "auto",
    /** background opacity, 30..100 */
    val opacity: Int = 100,
    /**
     * the account the project belongs to, or [ALL_ACCOUNTS] for an all-projects widget across every account.
     * Null for widgets set up before multi-account support: see [tools.lars.wgo.data.AccountStore.resolve].
     */
    val accountId: String? = null,
) {
    val allProjects: Boolean get() = projectId == ALL_PROJECTS
}

/**
 * The title of an all-projects widget. With several accounts connected, one scoped to a single [account] names
 * it, to tell it apart from the same widget for another account.
 */
fun allProjectsName(account: Account?, accounts: List<Account>): String =
    if (account != null && accounts.size > 1) "All projects · ${AccountStore.label(account, accounts)}" else "All projects"

/** The last fetched data plus fetch status. A failed refresh keeps the previous summary on screen. */
@Serializable
data class WidgetData(
    val summary: WidgetSummary? = null,
    /** set instead of [summary] for an all-projects widget */
    val overview: WidgetOverview? = null,
    val updatedAt: Long = 0,
    val refreshing: Boolean = false,
    val error: String? = null,
    /** auth (token revoked: pair again) | net (offline) | other */
    val errorKind: String? = null,
)

/**
 * Widget state lives in Glance's per-widget preferences, so writing it and calling update() always
 * recomposes the widget with the new values (data read outside the composition would go stale).
 */
object WidgetStore {
    val CONFIG = stringPreferencesKey("config")
    val DATA = stringPreferencesKey("data")

    fun config(prefs: Preferences): WidgetConfig? =
        prefs[CONFIG]?.let { runCatching { WgoJson.decodeFromString<WidgetConfig>(it) }.getOrNull() }

    fun data(prefs: Preferences): WidgetData =
        prefs[DATA]?.let { runCatching { WgoJson.decodeFromString<WidgetData>(it) }.getOrNull() } ?: WidgetData()

    suspend fun config(context: Context, id: GlanceId): WidgetConfig? =
        config(getAppWidgetState(context, PreferencesGlanceStateDefinition, id))

    suspend fun data(context: Context, id: GlanceId): WidgetData =
        data(getAppWidgetState(context, PreferencesGlanceStateDefinition, id))

    suspend fun saveConfig(context: Context, id: GlanceId, config: WidgetConfig) {
        updateAppWidgetState(context, id) { prefs ->
            val old = config(prefs)
            prefs[CONFIG] = WgoJson.encodeToString(WidgetConfig.serializer(), config)
            // a different project or account means the cached numbers no longer belong to this widget
            if (old != null && (old.projectId != config.projectId || old.accountId != config.accountId)) prefs[DATA] = WgoJson.encodeToString(WidgetData.serializer(), WidgetData())
        }
    }

    suspend fun updateData(context: Context, id: GlanceId, f: (WidgetData) -> WidgetData) {
        updateAppWidgetState(context, id) { prefs ->
            prefs[DATA] = WgoJson.encodeToString(WidgetData.serializer(), f(data(prefs)))
        }
    }

    suspend fun glanceIds(context: Context): List<GlanceId> =
        GlanceAppWidgetManager(context).getGlanceIds(StatsWidget::class.java)

    suspend fun glanceId(context: Context, appWidgetId: Int): GlanceId? =
        runCatching { GlanceAppWidgetManager(context).getGlanceIdBy(appWidgetId) }.getOrNull()
}
