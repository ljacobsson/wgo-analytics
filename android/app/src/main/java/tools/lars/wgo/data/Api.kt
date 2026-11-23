package tools.lars.wgo.data

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import tools.lars.wgo.BuildConfig
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ApiException(val status: Int, message: String) : IOException(message) {
    /** The token was revoked or never existed: the user must pair again. */
    val unauthorized get() = status == 401
}

/** Minimal client for the read-only widget API (`/widget/v1/…`), authenticated with the device token. */
class WgoApi(private val apiUrl: String, private val token: String) {
    constructor(a: Account) : this(a.apiUrl, a.token)

    suspend fun me(): WidgetMe = get("/widget/v1/me")

    suspend fun catalog(projectId: String): WidgetCatalog = get("/widget/v1/projects/${Uri.encode(projectId)}/catalog")

    suspend fun summary(projectId: String, range: String, stats: List<String>): WidgetSummary {
        // keys are comma-separated; dynamic keys (track:/event:/metric:) are URI-encoded so names may contain commas
        val keys = stats.joinToString(",") { Uri.encode(it) }
        return get("/widget/v1/projects/${Uri.encode(projectId)}/summary?range=${Uri.encode(range)}&stats=${Uri.encode(keys)}")
    }

    /** The same built-in stats for every project, busiest first. */
    suspend fun overview(range: String, stats: List<String>): WidgetOverview =
        get("/widget/v1/overview?range=${Uri.encode(range)}&stats=${Uri.encode(stats.joinToString(","))}")

    private suspend inline fun <reified T> get(path: String): T = withContext(Dispatchers.IO) {
        val conn = (URL(apiUrl + path).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "WGO-Android/${BuildConfig.VERSION_NAME}")
        }
        try {
            val status = conn.responseCode
            val body = (if (status in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (status !in 200..299) throw ApiException(status, errorMessage(status, body))
            WgoJson.decodeFromString<T>(body)
        } finally {
            conn.disconnect()
        }
    }

    private fun errorMessage(status: Int, body: String): String {
        val fromBody = runCatching { Json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()
        return fromBody ?: when (status) {
            401 -> "This device was disconnected"
            403 -> "Access denied"
            404 -> "Project not found"
            in 500..599 -> "Server error ($status)"
            else -> "Request failed ($status)"
        }
    }
}

/** Fetches the overview from every account at once. One account failing doesn't fail the others. */
suspend fun fetchOverviews(accounts: List<Account>, range: String, stats: List<String>): List<Pair<Account, Result<WidgetOverview>>> =
    coroutineScope {
        accounts.map { a -> async { a to runCatching { WgoApi(a).overview(range, stats) } } }.awaitAll()
    }

/**
 * One overview from several accounts' overviews: every row tagged with its account, busiest first by the first
 * stat (as the server orders them).
 */
fun mergeOverviews(parts: List<Pair<String, WidgetOverview>>): WidgetOverview? {
    val first = parts.firstOrNull()?.second ?: return null
    val lead = { r: OverviewRow -> r.stats.firstOrNull()?.value ?: -1.0 }
    val rows = parts.flatMap { (accountId, o) -> o.projects.map { it.copy(accountId = accountId) } }
        .sortedWith(compareByDescending(lead).thenBy { it.project.name.lowercase() })
    return first.copy(projects = rows, total = parts.sumOf { it.second.total })
}
