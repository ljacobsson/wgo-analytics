package tools.lars.wgo.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Mirrors of the widget API types in backend/src/contract.ts (WidgetMe, WidgetCatalog, WidgetSummary, WidgetOverview). */

val WgoJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

@Serializable
data class ProjectRef(val id: String, val name: String)

@Serializable
data class WidgetMe(val email: String, val projects: List<ProjectRef>)

@Serializable
data class StatOption(
    val key: String,
    val label: String,
    val description: String = "",
    val category: String = "",
)

@Serializable
data class WidgetCatalog(val options: List<StatOption>)

@Serializable
data class WidgetStat(
    val key: String,
    val label: String,
    val unit: String = "count", // count | ms | score | text
    val value: Double? = null,
    val previous: Double? = null,
    val better: String = "up", // up | down | none
    val rating: String? = null, // good | warn | bad
    val text: String? = null,
    val suffix: String? = null,
    val series: List<Double> = emptyList(),
    val page: String = "overview",
)

@Serializable
data class WidgetSummary(
    val project: ProjectRef,
    val range: String,
    val from: String,
    val to: String,
    val generatedAt: String,
    val stats: List<WidgetStat>,
)

@Serializable
data class OverviewRow(
    val project: ProjectRef,
    val stats: List<WidgetStat> = emptyList(),
    val error: String? = null,
    /** not from the API: the account the row came from, set by [mergeOverviews] */
    val accountId: String? = null,
)

@Serializable
data class WidgetOverview(
    val range: String,
    val from: String,
    val to: String,
    val generatedAt: String,
    /** projects the user can see; [projects] holds at most 30 of them */
    val total: Int,
    /** busiest first, by the first stat */
    val projects: List<OverviewRow>,
)

val RANGES = listOf("1h", "24h", "7d", "30d")

/** Built-in stats offered before the catalog has loaded, and the default selection for new widgets. */
val DEFAULT_STATS = listOf("visitors_now", "pageviews", "sessions", "errors")
const val MAX_STATS = 8

/** The project id a widget stores when it shows every project instead of one. */
const val ALL_PROJECTS = "*"

/** Stats an all-projects widget can show per row: built-ins only (track:/event:/metric: are per project), no text stats. */
val OVERVIEW_STATS = listOf(
    "visitors_now", "pageviews", "sessions", "users", "clicks", "errors", "http_errors",
    "lcp", "inp", "cls", "traces", "latency_p95", "span_errors", "log_errors",
)
val DEFAULT_OVERVIEW_STATS = listOf("pageviews", "visitors_now", "errors")
const val MAX_OVERVIEW_STATS = 3
