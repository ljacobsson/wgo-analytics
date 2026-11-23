package tools.lars.wgo.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import tools.lars.wgo.data.Account
import tools.lars.wgo.data.AccountStore
import tools.lars.wgo.data.ApiException
import tools.lars.wgo.data.ALL_ACCOUNTS
import tools.lars.wgo.data.ALL_PROJECTS
import tools.lars.wgo.data.DEFAULT_OVERVIEW_STATS
import tools.lars.wgo.data.DEFAULT_STATS
import tools.lars.wgo.data.Pairing
import tools.lars.wgo.data.ProjectRef
import tools.lars.wgo.data.Settings
import tools.lars.wgo.data.WgoApi
import tools.lars.wgo.widget.Refresher
import tools.lars.wgo.widget.Scheduler
import tools.lars.wgo.widget.StatsWidget
import tools.lars.wgo.widget.StatsWidgetReceiver
import tools.lars.wgo.widget.WidgetConfig
import tools.lars.wgo.widget.WidgetStore
import tools.lars.wgo.widget.allProjectsName
import java.io.IOException

class MainActivity : ComponentActivity() {
    private var incoming by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        if (savedInstanceState == null) incoming = intent?.dataString
        setContent { WgoTheme { MainScreen(incoming) { incoming = null } } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let { incoming = it }
    }
}

private sealed interface PairState {
    data object Idle : PairState
    data class Working(val host: String) : PairState
    data class Failed(val message: String) : PairState
}

@Composable
private fun MainScreen(incoming: String?, consumeIncoming: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var accounts by remember { mutableStateOf(AccountStore.all(ctx)) }
    var adding by remember { mutableStateOf(false) } // pairing another account while already connected
    var pair by remember { mutableStateOf<PairState>(PairState.Idle) }

    fun connect(p: Pairing) {
        pair = PairState.Working(Uri.parse(p.apiUrl).host ?: p.apiUrl)
        scope.launch {
            pair = try {
                val me = WgoApi(p.apiUrl, p.token).me()
                // the same deployment and user replaces the earlier token, so its widgets keep working
                AccountStore.save(ctx, Account(p.apiUrl, p.dashUrl, p.token, me.email))
                accounts = AccountStore.all(ctx)
                adding = false
                Refresher.refreshAll(ctx)
                PairState.Idle
            } catch (e: ApiException) {
                PairState.Failed(if (e.unauthorized) "This connection link was revoked or already replaced. Create a new one in the dashboard." else e.message ?: "Could not connect")
            } catch (e: IOException) {
                PairState.Failed("Couldn't reach ${Uri.parse(p.apiUrl).host}. Check your connection and try again.")
            }
        }
    }

    LaunchedEffect(incoming) {
        val raw = incoming ?: return@LaunchedEffect
        consumeIncoming()
        val p = AccountStore.parsePairing(raw)
        if (p == null) pair = PairState.Failed("That link isn't a valid WGO connection link.")
        else if (accounts.none { it.token == p.token }) connect(p)
    }

    Box(Modifier.fillMaxSize().background(Brand.bg)) {
        Column(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            BrandHeader()
            Spacer(Modifier.height(4.dp))
            when (val p = pair) {
                is PairState.Working -> Panel {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.5.dp, color = Brand.accent)
                        Spacer(Modifier.width(14.dp))
                        Text("Connecting to ${p.host}…", color = Brand.fg)
                    }
                }
                else -> {
                    if (p is PairState.Failed) Panel {
                        Text("Couldn't connect", color = Brand.bad, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(4.dp))
                        Text(p.message, color = Brand.muted, fontSize = 13.5.sp)
                    }
                    if (accounts.isEmpty()) Welcome(onConnect = ::connect)
                    else Home(
                        accounts,
                        adding = adding,
                        onAdding = { adding = it; if (!it) pair = PairState.Idle },
                        onConnect = ::connect,
                        onDisconnect = { a ->
                            AccountStore.remove(ctx, a.id)
                            accounts = AccountStore.all(ctx)
                            scope.launch { Refresher.refreshAll(ctx) } // its widgets switch to "Connect WGO"
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun Welcome(onConnect: (Pairing) -> Unit) {
    Panel {
        Text("Your stats, on your home screen", color = Brand.fg, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(
            "Live visitors, errors, Web Vitals and backend health from your WGO dashboard, in widgets you design yourself.",
            color = Brand.muted, fontSize = 14.sp,
        )
    }
    ConnectPanel("Connect this phone", onConnect)
    Text(
        "The connection is read-only. You can revoke it any time from the dashboard.",
        color = Brand.faint, fontSize = 12.5.sp, modifier = Modifier.padding(horizontal = 4.dp),
    )
}

/** Pairing steps plus a field for pasting a connection link. */
@Composable
private fun ConnectPanel(title: String, onConnect: (Pairing) -> Unit, onCancel: (() -> Unit)? = null) {
    val clipboard = LocalClipboardManager.current
    var text by remember { mutableStateOf("") }
    val parsed = AccountStore.parsePairing(text)

    Panel {
        SectionTitle(title)
        Step(1, "Open your WGO dashboard and go to Mobile widget.")
        Step(2, "Tap Connect a device. Scan the QR code with this phone, or open the link on it.")
        Step(3, "Or copy the connection link and paste it here:")
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("wgo://pair?…", color = Brand.faint) },
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = Brand.lineStrong, focusedBorderColor = Brand.accent),
            isError = text.isNotBlank() && parsed == null,
            supportingText = if (text.isNotBlank() && parsed == null) {
                { Text("That doesn't look like a connection link") }
            } else null,
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                onClick = { clipboard.getText()?.text?.let { text = it.trim() } },
                modifier = Modifier.height(50.dp),
                shape = RoundedCornerShape(14.dp),
            ) { Text("Paste", color = Brand.fg) }
            GradientButton("Connect", onClick = { parsed?.let(onConnect) }, enabled = parsed != null, modifier = Modifier.weight(1f))
        }
        if (onCancel != null) TextButton(onClick = onCancel, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
            Text("Cancel", color = Brand.muted)
        }
    }
}

@Composable
private fun Step(n: Int, text: String) {
    Row(Modifier.padding(vertical = 5.dp), verticalAlignment = Alignment.Top) {
        Box(
            Modifier.size(22.dp).clip(RoundedCornerShape(11.dp)).background(Brand.accent.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center,
        ) { Text("$n", color = Brand.accent, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
        Spacer(Modifier.width(10.dp))
        Text(text, color = Brand.muted, fontSize = 14.sp, modifier = Modifier.padding(top = 1.dp))
    }
}

@Composable
private fun Home(
    accounts: List<Account>,
    adding: Boolean,
    onAdding: (Boolean) -> Unit,
    onConnect: (Pairing) -> Unit,
    onDisconnect: (Account) -> Unit,
) {
    val ctx = LocalContext.current
    var reloads by remember { mutableIntStateOf(0) }
    var projectsBy by remember { mutableStateOf<Map<String, List<ProjectRef>>>(emptyMap()) }
    var errors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var loading by remember { mutableStateOf(true) }
    var accountId by remember { mutableStateOf<String?>(null) } // an account's id, or ALL_ACCOUNTS
    var selected by remember { mutableStateOf<String?>(null) }
    var widgetCount by remember { mutableIntStateOf(0) }
    var interval by remember { mutableIntStateOf(Settings.refreshMinutes(ctx)) }
    var confirmDisconnect by remember { mutableStateOf<Account?>(null) }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { reloads++ }

    LaunchedEffect(accounts, reloads) {
        if (reloads == 0) return@LaunchedEffect // ON_RESUME follows right away
        widgetCount = WidgetStore.glanceIds(ctx).size
        val results = coroutineScope { accounts.map { a -> async { a to runCatching { WgoApi(a).me() } } }.awaitAll() }
        projectsBy = results.mapNotNull { (a, r) -> r.getOrNull()?.let { a.id to it.projects } }.toMap()
        errors = results.mapNotNull { (a, r) ->
            when (val e = r.exceptionOrNull()) {
                null -> null
                is ApiException -> a.id to (if (e.unauthorized) "This phone was disconnected from this dashboard. Remove the account and pair again." else e.message ?: "Request failed")
                is IOException -> a.id to "Offline"
                else -> a.id to (e.message ?: "Request failed")
            }
        }.toMap()
        loading = false
    }

    // the choices, kept valid as accounts come and go
    val allAccounts = accountId == ALL_ACCOUNTS && accounts.size > 1
    val account = if (allAccounts) null else accounts.firstOrNull { it.id == accountId } ?: accounts.first()
    val list = account?.let { projectsBy[it.id] }
    val project = selected?.takeIf { s -> list.orEmpty().any { it.id == s } || (s == ALL_PROJECTS && list.orEmpty().size > 1) } ?: list?.firstOrNull()?.id

    accounts.forEach { a ->
        val error = errors[a.id]
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(if (error == null) Brand.good else Brand.warn)
                Spacer(Modifier.width(8.dp))
                Text(if (error == null) "Connected" else "Connection problem", color = Brand.fg, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(6.dp))
            Text(a.email, color = Brand.fg, fontSize = 15.sp)
            Text(a.host, color = Brand.faint, fontSize = 13.sp)
            error?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, color = Brand.warn, fontSize = 13.sp)
            }
            Row {
                if (a.dashUrl.isNotBlank()) {
                    TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(a.dashUrl))) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Text("Open dashboard", color = Brand.accent)
                    }
                    Spacer(Modifier.width(16.dp))
                }
                TextButton(onClick = { confirmDisconnect = a }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                    Text(if (accounts.size > 1) "Remove account" else "Disconnect", color = Brand.bad)
                }
            }
        }
    }

    if (adding) ConnectPanel("Add another account", onConnect, onCancel = { onAdding(false) })
    else OutlinedButton(onClick = { onAdding(true) }, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Icon(Icons.Default.Add, contentDescription = null, tint = Brand.fg, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Add another account", color = Brand.fg)
    }

    Panel {
        SectionTitle(
            "Add a widget",
            if (widgetCount == 0) "No widgets on your home screen yet" else "$widgetCount widget${if (widgetCount == 1) "" else "s"} on your home screen",
        )
        if (accounts.size > 1) {
            Text("Account", color = Brand.faint, fontSize = 12.sp)
            Spacer(Modifier.height(6.dp))
            ChipFlow(accounts.map { it.id to AccountStore.label(it, accounts) } + (ALL_ACCOUNTS to "All accounts"), account?.id ?: ALL_ACCOUNTS) { accountId = it }
            Spacer(Modifier.height(12.dp))
        }
        when {
            allAccounts -> {
                Text("One list with the projects from every account, busiest first.", color = Brand.muted, fontSize = 13.5.sp)
                Spacer(Modifier.height(12.dp))
                AddWidgetButton(WidgetConfig(ALL_PROJECTS, allProjectsName(null, accounts), DEFAULT_OVERVIEW_STATS, accountId = ALL_ACCOUNTS))
            }
            list == null && loading -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Brand.accent)
            list.isNullOrEmpty() -> Text(
                if (list != null) "You don't have any projects yet. Create one in the dashboard." else "Projects will show here once connected.",
                color = Brand.muted, fontSize = 13.5.sp,
            )
            else -> {
                if (list.size > 1) {
                    Text("Project", color = Brand.faint, fontSize = 12.sp)
                    Spacer(Modifier.height(6.dp))
                    ChipFlow(listOf(ALL_PROJECTS to "All projects") + list.map { it.id to it.name }, project) { selected = it }
                    Spacer(Modifier.height(12.dp))
                }
                AddWidgetButton(
                    if (project == ALL_PROJECTS) WidgetConfig(ALL_PROJECTS, allProjectsName(account, accounts), DEFAULT_OVERVIEW_STATS, accountId = account?.id)
                    else (list.firstOrNull { it.id == project } ?: list.first()).let { WidgetConfig(it.id, it.name, DEFAULT_STATS, accountId = account?.id) },
                )
            }
        }
    }

    Panel {
        SectionTitle("Background refresh", "Android allows background updates at most every 15 minutes. Tap ↻ on a widget to update it right away.")
        ChipFlow(Settings.INTERVALS.map { it.toString() to if (it < 60) "$it min" else "${it / 60} h" }, interval.toString()) {
            interval = it.toInt()
            Settings.setRefreshMinutes(ctx, interval)
            Scheduler.schedulePeriodic(ctx, replace = true)
        }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(
            onClick = {
                Scheduler.refreshNow(ctx)
                Toast.makeText(ctx, "Refreshing widgets…", Toast.LENGTH_SHORT).show()
            },
            shape = RoundedCornerShape(12.dp),
        ) {
            Icon(Icons.Default.Refresh, contentDescription = null, tint = Brand.fg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Refresh all widgets now", color = Brand.fg)
        }
    }

    confirmDisconnect?.let { a ->
        AlertDialog(
            onDismissRequest = { confirmDisconnect = null },
            title = { Text(if (accounts.size > 1) "Remove ${a.host}?" else "Disconnect?") },
            text = { Text("Widgets for this account stop updating until you pair it again. To revoke this phone's access completely, remove it under Mobile widget in the dashboard.") },
            confirmButton = {
                TextButton(onClick = { confirmDisconnect = null; onDisconnect(a) }) {
                    Text(if (accounts.size > 1) "Remove" else "Disconnect", color = Brand.bad)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDisconnect = null }) { Text("Cancel") } },
            containerColor = Brand.raised,
        )
    }
}

@Composable
private fun AddWidgetButton(config: WidgetConfig) {
    val ctx = LocalContext.current
    GradientButton(
        "Add to home screen",
        icon = { Icon(Icons.Default.Add, contentDescription = null, tint = androidx.compose.ui.graphics.Color.White) },
        onClick = {
            val ok = StatsWidgetReceiver.requestPin(ctx, config)
            if (!ok) Toast.makeText(ctx, "Long-press your home screen, tap Widgets, then choose WGO", Toast.LENGTH_LONG).show()
        },
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(10.dp))
    Text(
        "Or long-press your home screen, tap Widgets, and drag WGO. You can resize it: it rearranges itself from a single number up to a full board. Tap a widget's title to change its stats.",
        color = Brand.faint, fontSize = 12.5.sp,
    )
}

/** Wrapping row of single-select chips. */
@Composable
fun ChipFlow(options: List<Pair<String, String>>, selected: String?, onSelect: (String) -> Unit) {
    @OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, label) ->
            FilterChip(
                selected = value == selected,
                onClick = { onSelect(value) },
                label = { Text(label, fontSize = 13.5.sp) },
                shape = RoundedCornerShape(10.dp),
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = Brand.accent.copy(alpha = 0.22f),
                    selectedLabelColor = Brand.fg,
                    labelColor = Brand.muted,
                ),
            )
        }
    }
}
