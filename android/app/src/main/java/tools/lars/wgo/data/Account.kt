package tools.lars.wgo.data

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import androidx.core.content.edit
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.security.MessageDigest

/**
 * A paired WGO account: API base URL, dashboard URL (for tap-through) and a read-only device token.
 * A phone can be paired with several accounts, e.g. a private and a work deployment.
 * Stored in app-private SharedPreferences, excluded from backups (see res/xml/backup_rules.xml).
 */
@Serializable
data class Account(
    val apiUrl: String,
    val dashUrl: String,
    val token: String,
    val email: String,
    /** stable per deployment + user, so pairing the same account again keeps its widgets: see [AccountStore.idFor] */
    val id: String = AccountStore.idFor(apiUrl, email),
) {
    val host: String get() = Uri.parse(dashUrl.ifBlank { apiUrl }).host ?: apiUrl
}

/** What a connection link carries before it has been verified against the API. */
data class Pairing(val apiUrl: String, val dashUrl: String, val token: String)

/** The account id a widget stores when it shows projects from every connected account. */
const val ALL_ACCOUNTS = "*"

object AccountStore {
    private const val PREFS = "wgo.account"
    private const val ACCOUNTS = "accounts"
    /** the account paired before multi-account support; widgets from then store no account id */
    private const val LEGACY = "legacyId"

    fun idFor(apiUrl: String, email: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("${apiUrl.trimEnd('/')}|${email.lowercase()}".toByteArray())
        return digest.take(8).joinToString("") { "%02x".format(it) }
    }

    /** Every connected account, in the order they were added. */
    fun all(context: Context): List<Account> {
        val p = prefs(context)
        migrate(p)
        return p.getString(ACCOUNTS, null)
            ?.let { runCatching { WgoJson.decodeFromString<List<Account>>(it) }.getOrNull() }
            ?: emptyList()
    }

    fun get(context: Context, id: String): Account? = all(context).firstOrNull { it.id == id }

    /**
     * The accounts a widget reads from: every account for [ALL_ACCOUNTS], else the one it names. Widgets set up
     * before multi-account support store no id and keep using the account that was paired back then.
     */
    fun resolve(context: Context, accountId: String?): List<Account> {
        val all = all(context)
        if (accountId == ALL_ACCOUNTS) return all
        val id = accountId ?: prefs(context).getString(LEGACY, null) ?: return emptyList()
        return all.filter { it.id == id }
    }

    /** Adds the account, or replaces the token of the same account (same deployment and user) paired earlier. */
    fun save(context: Context, a: Account) {
        val list = all(context)
        val i = list.indexOfFirst { it.id == a.id }
        write(context, if (i >= 0) list.toMutableList().also { it[i] = a } else list + a)
    }

    fun remove(context: Context, id: String) = write(context, all(context).filterNot { it.id == id })

    /** A short name for [a]: its host, plus the email when another account shares that host. */
    fun label(a: Account, all: List<Account>): String =
        if (all.count { it.host == a.host } > 1) "${a.email} · ${a.host}" else a.host

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun write(context: Context, list: List<Account>) = prefs(context).edit {
        putString(ACCOUNTS, WgoJson.encodeToString(ListSerializer(Account.serializer()), list))
    }

    /** Moves the single account of earlier versions into the list. */
    private fun migrate(p: SharedPreferences) {
        if (p.contains(ACCOUNTS)) return
        val api = p.getString("api", null)
        val token = p.getString("token", null)
        val list = if (api != null && token != null) listOf(Account(api, p.getString("dash", "") ?: "", token, p.getString("email", "") ?: "")) else emptyList()
        p.edit {
            putString(ACCOUNTS, WgoJson.encodeToString(ListSerializer(Account.serializer()), list))
            list.firstOrNull()?.let { putString(LEGACY, it.id) }
            remove("api"); remove("dash"); remove("token"); remove("email")
        }
    }

    /**
     * Accepts any of the forms the dashboard hands out:
     *   wgo://pair?api=…&dash=…&token=dt_…
     *   https://<dashboard>/pair.html#api=…&dash=…&token=dt_…
     * or that text pasted with surrounding whitespace.
     */
    fun parsePairing(raw: String?): Pairing? {
        val text = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val uri = runCatching { Uri.parse(text) }.getOrNull() ?: return null
        val params = buildMap {
            fun addAll(s: String?) = s?.split('&')?.forEach { kv ->
                val i = kv.indexOf('=')
                if (i > 0) put(kv.substring(0, i), Uri.decode(kv.substring(i + 1)))
            }
            addAll(uri.encodedQuery)
            addAll(uri.encodedFragment)
        }
        val token = params["token"]?.takeIf { Regex("^dt_[A-Za-z0-9]{20,80}$").matches(it) } ?: return null
        val api = params["api"]?.trimEnd('/')?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: return null
        val dash = params["dash"]?.trimEnd('/')
            ?: if (uri.scheme == "https" || uri.scheme == "http") "${uri.scheme}://${uri.authority}" else ""
        return Pairing(api, dash, token)
    }
}

/** App-wide settings. */
object Settings {
    private const val PREFS = "wgo.settings"
    val INTERVALS = listOf(15, 30, 60, 180)

    fun refreshMinutes(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("refreshMinutes", 30)

    fun setRefreshMinutes(context: Context, minutes: Int) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putInt("refreshMinutes", minutes) }
}
