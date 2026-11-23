package tools.lars.wgo.ui

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import tools.lars.wgo.data.ALL_ACCOUNTS
import tools.lars.wgo.data.ALL_PROJECTS
import tools.lars.wgo.data.AccountStore
import tools.lars.wgo.data.DEFAULT_OVERVIEW_STATS
import tools.lars.wgo.data.DEFAULT_STATS
import tools.lars.wgo.data.MAX_OVERVIEW_STATS
import tools.lars.wgo.data.MAX_STATS
import tools.lars.wgo.data.OVERVIEW_STATS
import tools.lars.wgo.data.OverviewRow
import tools.lars.wgo.data.ProjectRef
import tools.lars.wgo.data.RANGES
import tools.lars.wgo.data.StatOption
import tools.lars.wgo.data.WgoApi
import tools.lars.wgo.data.WidgetOverview
import tools.lars.wgo.data.WidgetStat
import tools.lars.wgo.data.WidgetSummary
import tools.lars.wgo.data.fetchOverviews
import tools.lars.wgo.data.mergeOverviews
import tools.lars.wgo.widget.Fmt
import tools.lars.wgo.widget.Scheduler
import tools.lars.wgo.widget.StatsWidget
import tools.lars.wgo.widget.WidgetConfig
import tools.lars.wgo.widget.WidgetData
import tools.lars.wgo.widget.WidgetStore
import tools.lars.wgo.widget.allProjectsName

/** Widget configuration: shown when a widget is placed, and when its title is tapped. */
class ConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        val appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        // backing out of first-time setup must not leave an empty widget behind
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        setContent {
            WgoTheme {
                ConfigScreen(appWidgetId) {
                    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
                    finish()
                }
            }
        }
    }
}

private val THEMES = listOf("auto" to "Auto", "dark" to "Dark", "light" to "Light", "system" to "Material You")

@Composable
private fun ConfigScreen(appWidgetId: Int, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var accounts by remember { mutableStateOf(AccountStore.all(ctx)) }
    var accountId by remember { mutableStateOf<String?>(null) } // an account's id, or ALL_ACCOUNTS
    var projectsBy by remember { mutableStateOf<Map<String, List<ProjectRef>>>(emptyMap()) }
    var options by remember { mutableStateOf<List<StatOption>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }

    var projectId by remember { mutableStateOf<String?>(null) }
    var range by remember { mutableStateOf("24h") }
    val stats = remember { mutableStateListOf<String>() }
    var theme by remember { mutableStateOf("auto") }
    var opacity by remember { mutableFloatStateOf(100f) }
    var preview by remember { mutableStateOf<List<WidgetStat>?>(null) }
    var overviewPreview by remember { mutableStateOf<WidgetOverview?>(null) }
    var previewFor by remember { mutableStateOf("") } // which project/range/stats `preview` was computed for
    var saving by remember { mutableStateOf(false) }

    val allAccounts = accountId == ALL_ACCOUNTS
    val account = accounts.firstOrNull { it.id == accountId }
    /** the accounts the widget reads from */
    val selected = if (allAccounts) accounts else listOfNotNull(account)
    val projects = if (allAccounts) null else account?.let { projectsBy[it.id] }
    val allProjects = projectId == ALL_PROJECTS
    val maxStats = if (allProjects) MAX_OVERVIEW_STATS else MAX_STATS

    fun selectProject(id: String) {
        // an overview row has room for a few built-in stats only
        if (id == ALL_PROJECTS && !allProjects) {
            val keep = stats.filter { it in OVERVIEW_STATS }.take(MAX_OVERVIEW_STATS).ifEmpty { DEFAULT_OVERVIEW_STATS }
            stats.clear(); stats.addAll(keep)
        }
        projectId = id
    }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { accounts = AccountStore.all(ctx) }

    // existing config (reconfigure) + every account's projects
    LaunchedEffect(accounts) {
        if (accounts.isEmpty()) return@LaunchedEffect
        if (!loaded) {
            WidgetStore.glanceId(ctx, appWidgetId)?.let { WidgetStore.config(ctx, it) }?.let { c ->
                projectId = c.projectId; range = c.range; theme = c.theme; opacity = c.opacity.toFloat()
                stats.clear(); stats.addAll(c.stats)
                accountId = if (c.accountId == ALL_ACCOUNTS) ALL_ACCOUNTS else AccountStore.resolve(ctx, c.accountId).firstOrNull()?.id
            }
            if (stats.isEmpty()) stats.addAll(DEFAULT_STATS)
            loaded = true
        }
        if (accountId != ALL_ACCOUNTS && accounts.none { it.id == accountId }) accountId = accounts.first().id
        val results = coroutineScope { accounts.map { a -> async { a to runCatching { WgoApi(a).me() } } }.awaitAll() }
        projectsBy = results.mapNotNull { (a, r) -> r.getOrNull()?.let { a.id to it.projects } }.toMap()
        error = results.firstNotNullOfOrNull { (a, r) ->
            r.exceptionOrNull()?.let { e -> (e.message ?: "Couldn't load your projects").let { if (accounts.size > 1) "${a.host}: $it" else it } }
        }
    }

    // keep the project valid for the chosen account
    LaunchedEffect(accountId, projectsBy) {
        if (allAccounts) return@LaunchedEffect selectProject(ALL_PROJECTS)
        val list = projects ?: return@LaunchedEffect
        val known = list.any { it.id == projectId } || (projectId == ALL_PROJECTS && list.isNotEmpty())
        if (!known) projectId = list.firstOrNull()?.id
    }

    LaunchedEffect(projectId, accountId, projectsBy) {
        // an overview offers built-ins only, which every project's catalog lists
        val a = selected.firstOrNull { !projectsBy[it.id].isNullOrEmpty() } ?: return@LaunchedEffect
        val pid = (if (allProjects) projectsBy[a.id]?.firstOrNull()?.id else projectId) ?: return@LaunchedEffect
        runCatching { WgoApi(a).catalog(pid) }.onSuccess { options = it.options }
    }

    // live preview with real numbers, debounced while the user is picking
    LaunchedEffect(projectId, range, stats.toList(), selected) {
        val pid = projectId ?: return@LaunchedEffect
        if (selected.isEmpty()) return@LaunchedEffect
        if (stats.isEmpty()) { preview = emptyList(); overviewPreview = null; return@LaunchedEffect }
        delay(350)
        val keys = stats.toList()
        val key = "$accountId|$pid|$range|$keys"
        if (pid == ALL_PROJECTS) {
            if (keys.any { it !in OVERVIEW_STATS } || keys.size > MAX_OVERVIEW_STATS) return@LaunchedEffect
            val parts = fetchOverviews(selected, range, keys).mapNotNull { (a, r) -> r.getOrNull()?.let { a.id to it } }
            mergeOverviews(parts)?.let { overviewPreview = it; previewFor = key }
        } else {
            runCatching { WgoApi(selected.first()).summary(pid, range, keys) }.onSuccess { preview = it.stats; previewFor = key }
        }
    }

    val labelOf = { key: String -> options.firstOrNull { it.key == key }?.label ?: key.substringAfter(':').replace('_', ' ').replaceFirstChar { it.uppercase() } }

    fun save() {
        val pid = projectId ?: return
        val name = if (pid == ALL_PROJECTS) allProjectsName(account, accounts) else projects?.firstOrNull { it.id == pid }?.name ?: ""
        saving = true
        scope.launch {
            val id = WidgetStore.glanceId(ctx, appWidgetId)
            if (id == null) {
                Toast.makeText(ctx, "This widget no longer exists", Toast.LENGTH_SHORT).show()
                onDone()
                return@launch
            }
            WidgetStore.saveConfig(ctx, id, WidgetConfig(pid, name, stats.toList(), range, theme, opacity.toInt(), accountId))
            // show the preview's numbers immediately; the refresh below replaces them within seconds
            val fresh = previewFor == "$accountId|$pid|$range|${stats.toList()}"
            val shown = preview?.takeIf { fresh && pid != ALL_PROJECTS }
            val shownOverview = overviewPreview?.takeIf { fresh && pid == ALL_PROJECTS }
            if (shown != null) WidgetStore.updateData(ctx, id) {
                WidgetData(summary = WidgetSummary(ProjectRef(pid, name), range, "", "", "", shown), updatedAt = System.currentTimeMillis(), refreshing = true)
            }
            if (shownOverview != null) WidgetStore.updateData(ctx, id) {
                WidgetData(overview = shownOverview, updatedAt = System.currentTimeMillis(), refreshing = true)
            }
            StatsWidget().update(ctx, id)
            Scheduler.schedulePeriodic(ctx)
            Scheduler.refreshNow(ctx, appWidgetId)
            onDone()
        }
    }

    Box(Modifier.fillMaxSize().background(Brand.bg)) {
        if (accounts.isEmpty()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                BrandHeader("Widget setup")
                Panel {
                    SectionTitle("Connect WGO first", "Pair this phone with your dashboard, then come back here.")
                    GradientButton("Open WGO", onClick = { ctx.startActivity(Intent(ctx, MainActivity::class.java)) }, modifier = Modifier.fillMaxWidth())
                }
            }
            return@Box
        }

        val grouped = options.filter { it.key !in stats && (!allProjects || it.key in OVERVIEW_STATS) }.groupBy { it.category }
        LazyColumn(
            Modifier.fillMaxSize().safeDrawingPadding(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 110.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item { BrandHeader("Widget setup") }
            error?.let { e -> item { Panel { Text(e, color = Brand.warn, fontSize = 13.5.sp) } } }

            item {
                Panel {
                    val list = projects
                    if (accounts.size > 1) {
                        SectionTitle("Account", if (allAccounts) "Projects from every connected account in one list" else null)
                        ChipFlow(accounts.map { it.id to AccountStore.label(it, accounts) } + (ALL_ACCOUNTS to "All accounts"), accountId) { accountId = it }
                        Spacer(Modifier.height(16.dp))
                    }
                    if (allAccounts) {
                        SectionTitle("Project", "One row per project, busiest first")
                        ChipFlow(listOf(ALL_PROJECTS to "All projects"), ALL_PROJECTS) {}
                    } else if (list == null) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Brand.accent)
                    } else {
                        SectionTitle("Project", if (allProjects) "One row per project, busiest first" else null)
                        val choices = list.map { it.id to it.name }
                        ChipFlow(if (list.size > 1) listOf(ALL_PROJECTS to "All projects") + choices else choices, projectId) { selectProject(it) }
                    }
                    Spacer(Modifier.height(16.dp))
                    SectionTitle("Time range", "Totals, comparisons and sparklines cover this window")
                    ChipFlow(RANGES.map { it to it }, range) { range = it }
                }
            }

            item {
                Panel {
                    SectionTitle(
                        "Your stats",
                        if (allProjects) "Shown for every project. The first one orders the list and gets a chart. Pick up to $maxStats."
                        else "The first one is shown largest. Pick up to $maxStats.",
                    )
                    if (stats.isEmpty()) Text("Add stats from the list below.", color = Brand.faint, fontSize = 13.5.sp)
                    stats.forEachIndexed { i, key ->
                        SelectedRow(
                            index = i, label = labelOf(key), first = i == 0, last = i == stats.lastIndex,
                            onUp = { stats.add(i - 1, stats.removeAt(i)) },
                            onDown = { stats.add(i + 1, stats.removeAt(i)) },
                            onRemove = { stats.removeAt(i) },
                        )
                    }
                }
            }

            item {
                if (allProjects) {
                    val hostOf = { id: String? -> accounts.firstOrNull { it.id == id }?.let { AccountStore.label(it, accounts) } }
                    OverviewPreview(overviewPreview?.takeIf { previewFor.startsWith("$accountId|") }, stats.toList(), labelOf, if (allAccounts && accounts.size > 1) hostOf else null)
                } else Preview(preview, stats.toList(), labelOf)
            }

            grouped.forEach { (category, opts) ->
                item(key = "cat-$category") {
                    Text(category.uppercase(), color = Brand.faint, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 4.dp, top = 6.dp))
                }
                items(opts, key = { it.key }) { opt ->
                    OptionRow(opt, enabled = stats.size < maxStats) {
                        if (stats.size < maxStats) stats.add(opt.key)
                        else Toast.makeText(ctx, if (allProjects) "An all-projects widget shows at most $maxStats stats" else "A widget shows at most $maxStats stats", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            if (options.isEmpty()) item {
                Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = Brand.accent)
                }
            }

            item {
                Panel {
                    SectionTitle("Appearance")
                    ChipFlow(THEMES, theme) { theme = it }
                    Spacer(Modifier.height(14.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Background", color = Brand.muted, fontSize = 13.5.sp, modifier = Modifier.width(96.dp))
                        Slider(
                            value = opacity, onValueChange = { opacity = it }, valueRange = 30f..100f, modifier = Modifier.weight(1f),
                            colors = SliderDefaults.colors(thumbColor = Brand.accent, activeTrackColor = Brand.accent),
                        )
                        Text("${opacity.toInt()}%", color = Brand.fg, fontSize = 13.sp, modifier = Modifier.width(44.dp).padding(start = 8.dp))
                    }
                }
            }
        }

        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(Brand.bg.copy(alpha = 0.94f))
                .navigationBarsPadding()
                .padding(horizontal = 20.dp, vertical = 14.dp),
        ) {
            GradientButton(
                if (saving) "Saving…" else "Save widget",
                onClick = ::save,
                enabled = !saving && projectId != null && stats.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun SelectedRow(index: Int, label: String, first: Boolean, last: Boolean, onUp: () -> Unit, onDown: () -> Unit, onRemove: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp).clip(RoundedCornerShape(12.dp)).background(Brand.tile).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(22.dp).clip(RoundedCornerShape(11.dp)).background(if (first) Brand.accent else Brand.accent.copy(alpha = 0.18f)),
            contentAlignment = Alignment.Center,
        ) { Text("${index + 1}", color = if (first) Color.White else Brand.accent, fontSize = 11.5.sp, fontWeight = FontWeight.Bold) }
        Spacer(Modifier.width(10.dp))
        Text(label, color = Brand.fg, fontSize = 14.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        IconButton(onClick = onUp, enabled = !first) { Icon(Icons.Default.KeyboardArrowUp, "Move up", tint = if (first) Brand.faint.copy(alpha = 0.4f) else Brand.muted) }
        IconButton(onClick = onDown, enabled = !last) { Icon(Icons.Default.KeyboardArrowDown, "Move down", tint = if (last) Brand.faint.copy(alpha = 0.4f) else Brand.muted) }
        IconButton(onClick = onRemove) { Icon(Icons.Default.Close, "Remove", tint = Brand.muted) }
    }
}

@Composable
private fun OptionRow(opt: StatOption, enabled: Boolean, onAdd: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Brand.raised)
            .clickable(onClick = onAdd)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(opt.label, color = Brand.fg, fontSize = 14.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (opt.description.isNotBlank()) Text(opt.description, color = Brand.faint, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.Default.Add, contentDescription = "Add", tint = if (enabled) Brand.accent else Brand.faint)
    }
}

/** A Compose rendition of an all-projects widget: one row per project with the chosen stats. */
@Composable
private fun OverviewPreview(overview: WidgetOverview?, keys: List<String>, labelOf: (String) -> String, accountLabel: ((String?) -> String?)?) {
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Preview", color = Brand.fg, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (overview == null) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = Brand.accent)
            else Icon(Icons.Default.Check, contentDescription = null, tint = Brand.good, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.height(10.dp))
        Row(Modifier.padding(horizontal = 12.dp)) {
            Text("Project", color = Brand.faint, fontSize = 11.sp, modifier = Modifier.weight(1f))
            keys.forEach { Text(labelOf(it), color = Brand.faint, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.End, modifier = Modifier.width(72.dp)) }
        }
        val rows = overview?.projects ?: emptyList()
        rows.forEach { row -> OverviewPreviewRow(row, keys, accountLabel?.invoke(row.accountId)) }
        overview?.let { if (it.total > rows.size) Text("Showing the busiest ${rows.size} of ${it.total} projects", color = Brand.faint, fontSize = 12.sp, modifier = Modifier.padding(start = 4.dp, top = 6.dp)) }
    }
}

@Composable
private fun OverviewPreviewRow(row: OverviewRow, keys: List<String>, account: String?) {
    val byKey = row.stats.associateBy { it.key }
    Row(
        Modifier.fillMaxWidth().padding(top = 6.dp).clip(RoundedCornerShape(12.dp)).background(Brand.tile).padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(row.project.name, color = Brand.fg, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            row.error?.let { Text(it, color = Brand.warn, fontSize = 11.5.sp) }
                ?: account?.let { Text(it, color = Brand.faint, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        keys.forEachIndexed { i, key ->
            val s = byKey[key]
            Column(Modifier.width(72.dp), horizontalAlignment = Alignment.End) {
                Text(
                    s?.let { Fmt.value(it) } ?: "–",
                    color = when (s?.rating) { "good" -> Brand.good; "warn" -> Brand.warn; "bad" -> Brand.bad; else -> Brand.fg },
                    fontSize = if (i == 0) 16.sp else 14.sp, fontWeight = FontWeight.Bold, maxLines = 1,
                )
                if (i == 0) s?.let { Fmt.delta(it) }?.let { d ->
                    Text(d.label, color = when (d.tone) { Fmt.Tone.GOOD -> Brand.good; Fmt.Tone.BAD -> Brand.bad; else -> Brand.faint }, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/** A Compose rendition of the widget's tiles, filled with real numbers. */
@Composable
private fun Preview(stats: List<WidgetStat>?, keys: List<String>, labelOf: (String) -> String) {
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Preview", color = Brand.fg, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (stats == null) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = Brand.accent)
            else Icon(Icons.Default.Check, contentDescription = null, tint = Brand.good, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.height(10.dp))
        val byKey = stats?.associateBy { it.key } ?: emptyMap()
        keys.chunked(2).forEachIndexed { r, pair ->
            if (r > 0) Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                pair.forEach { key ->
                    val s = byKey[key]
                    Column(
                        Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).background(Brand.tile).padding(horizontal = 12.dp, vertical = 10.dp),
                    ) {
                        Text(s?.label ?: labelOf(key), color = Brand.muted, fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            s?.let { if (it.unit == "text") Fmt.text(it) else Fmt.value(it) } ?: "…",
                            color = when (s?.rating) { "good" -> Brand.good; "warn" -> Brand.warn; "bad" -> Brand.bad; else -> Brand.fg },
                            fontSize = if (r == 0 && key == keys.first()) 22.sp else 18.sp, fontWeight = FontWeight.Bold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        val d = s?.let { Fmt.delta(it) }
                        Text(
                            d?.label ?: " ",
                            color = when (d?.tone) { Fmt.Tone.GOOD -> Brand.good; Fmt.Tone.BAD -> Brand.bad; else -> Brand.faint },
                            fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}
