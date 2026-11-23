package tools.lars.wgo.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.CircularProgressIndicator
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.itemsIndexed
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import tools.lars.wgo.R
import tools.lars.wgo.data.Account
import tools.lars.wgo.data.AccountStore
import tools.lars.wgo.data.OverviewRow
import tools.lars.wgo.data.WidgetStat
import tools.lars.wgo.ui.ConfigActivity
import tools.lars.wgo.ui.MainActivity
import java.util.Date
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

class StatsWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override val stateDefinition: GlanceStateDefinition<*> = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        provideContent {
            val prefs = currentState<Preferences>()
            val config = WidgetStore.config(prefs)
            val data = WidgetStore.data(prefs)
            val pal = Palette.forTheme(context, config?.theme ?: "auto", config?.opacity ?: 100)
            Content(appWidgetId, config, data, config?.let { AccountStore.resolve(context, it.accountId) }.orEmpty(), pal)
        }
    }
}

private const val PAD = 12f
private const val GAP = 8f
private const val HEADER = 44f // header row + gap below it
private const val MAX_CHILDREN = 10 // Glance renders at most 10 children per Row/Column/Box

/** Everything a layout needs, resolved once per composition. */
private class Ui(
    val ctx: Context,
    val pal: Palette,
    val appWidgetId: Int,
    val config: WidgetConfig,
    val data: WidgetData,
    /** the widget's account, or every account for an all-accounts overview */
    val accounts: List<Account>,
) {
    /** several accounts: rows name the one they come from */
    val multi: Boolean get() = accounts.size > 1
    fun configure(): Action = actionStartActivity(
        Intent(ctx, ConfigActivity::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .setData(Uri.parse("wgo://configure/$appWidgetId")) // distinct PendingIntent per widget
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
    )

    fun account(id: String?): Account = accounts.firstOrNull { it.id == id } ?: accounts.first()

    fun label(row: OverviewRow): String = AccountStore.label(account(row.accountId), accounts)

    fun open(page: String, projectId: String = config.projectId, accountId: String? = null): Action {
        val dash = account(accountId).dashUrl
        if (dash.isBlank()) return actionStartActivity(Intent(ctx, MainActivity::class.java))
        val url = "$dash/#/p/${Uri.encode(projectId)}/$page?range=${config.range}"
        return actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

@Composable
private fun Content(appWidgetId: Int, config: WidgetConfig?, data: WidgetData, accounts: List<Account>, pal: Palette) {
    val ctx = LocalContext.current
    Box(
        modifier = GlanceModifier.fillMaxSize().appWidgetBackground().background(pal.bg).cornerRadius(24.dp).padding(PAD.dp),
    ) {
        when {
            config == null -> Prompt(
                pal, "Set up widget", "Pick a project and the stats you want to see",
                actionStartActivity(
                    Intent(ctx, ConfigActivity::class.java)
                        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                        .setData(Uri.parse("wgo://configure/$appWidgetId"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                ),
            )
            accounts.isEmpty() || data.errorKind == "auth" -> Prompt(
                pal,
                if (accounts.isEmpty()) "Connect WGO" else "Device disconnected",
                "Tap to pair this phone with your dashboard",
                actionStartActivity(Intent(ctx, MainActivity::class.java)),
            )
            else -> Body(Ui(ctx, pal, appWidgetId, config, data, accounts))
        }
    }
}

@Composable
private fun Body(ui: Ui) {
    val size = LocalSize.current
    val w = size.width.value - 2 * PAD
    val h = size.height.value - 2 * PAD
    val overview = ui.data.overview?.takeIf { ui.config.allProjects }
    val stats = ui.data.summary?.stats?.takeIf { !ui.config.allProjects }
    when {
        overview != null && overview.projects.isNotEmpty() -> Overview(ui, overview.projects, overview.total, w, h)
        overview != null -> Placeholder(ui, w, h, "No projects yet", warn = false, retry = false)
        stats.isNullOrEmpty() -> {
            val err = ui.data.error?.takeIf { !ui.data.refreshing }
            Placeholder(ui, w, h, if (err != null) "$err · tap to retry" else "Loading…", warn = err != null, retry = true)
        }
        w < 170 && h < 200 -> Compact(ui, stats, w, h)
        w < 170 -> Tall(ui, stats, w, h)
        // a board needs room for the hero chart plus at least one row of tiles
        h < 250 -> Strip(ui, stats, w, h)
        else -> Board(ui, stats, w, h)
    }
}

/** No numbers to show yet: loading, a failed first load, or nothing to list. */
@Composable
private fun Placeholder(ui: Ui, w: Float, h: Float, message: String, warn: Boolean, retry: Boolean) {
    Column(GlanceModifier.fillMaxSize()) {
        if (h >= 70) Header(ui, compact = w < 160)
        val box = GlanceModifier.fillMaxSize()
        Box(if (retry) box.clickable(actionRunCallback<RefreshAction>()) else box, contentAlignment = Alignment.Center) {
            Text(message, style = TextStyle(color = ui.pal.p(if (warn) ui.pal.warn else ui.pal.muted), fontSize = 12.sp))
        }
    }
}

// ------------------------------------------------------------------ layouts

/** 2×1 / 2×2: the first stat, big. */
@Composable
private fun Compact(ui: Ui, stats: List<WidgetStat>, w: Float, h: Float) {
    Column(GlanceModifier.fillMaxSize()) {
        val showHeader = h >= 120
        if (showHeader) Header(ui, compact = true)
        Hero(ui, stats.first(), w, if (showHeader) h - HEADER else h, bare = true, size = GlanceModifier.fillMaxWidth().defaultWeight())
    }
}

/** Narrow and tall: a list, one stat per row. */
@Composable
private fun Tall(ui: Ui, stats: List<WidgetStat>, w: Float, h: Float) {
    val rowH = 50f
    val fit = max(1, floor((h * 0.92f - HEADER + GAP) / (rowH + GAP)).toInt()) // reported height runs a little large
    Column(GlanceModifier.fillMaxSize()) {
        Header(ui, compact = true)
        stats.take(fit).forEachIndexed { i, s ->
            if (i > 0) Spacer(GlanceModifier.height(GAP.dp))
            ListRow(ui, s, w, rowH)
        }
    }
}

/** Wide and short (4×1, 4×2 on most launchers): a row of tiles. */
@Composable
private fun Strip(ui: Ui, stats: List<WidgetStat>, w: Float, h: Float) {
    val showHeader = h >= 110
    val tileH = if (showHeader) h - HEADER else h
    val n = min(stats.size, max(1, floor((w + GAP) / (92f + GAP)).toInt()))
    val tileW = (w - GAP * (n - 1)) / n
    Column(GlanceModifier.fillMaxSize()) {
        if (showHeader) Header(ui, compact = false)
        // weighted, not tileH: launchers report a slightly larger size than they lay out
        Row(GlanceModifier.fillMaxWidth().defaultWeight()) {
            stats.take(n).forEachIndexed { i, s ->
                if (i > 0) Spacer(GlanceModifier.width(GAP.dp))
                Tile(ui, s, tileW, tileH, GlanceModifier.defaultWeight())
            }
        }
    }
}

/** 4×3 and up: a hero stat with a large chart, then a grid. */
@Composable
private fun Board(ui: Ui, stats: List<WidgetStat>, w: Float, h: Float) {
    val cols = if (w >= 330) 3 else 2
    val rest = stats.drop(1)
    val minHero = 104f
    val minTile = 68f
    val rowsFit = floor((h - HEADER - minHero) / (minTile + GAP)).toInt().coerceAtLeast(0)
    val rows = min(rowsFit, (rest.size + cols - 1) / cols)
    // give the hero up to 46% of the height and share what is left between the tile rows
    val heroH = if (rows == 0) h - HEADER else max(minHero, min((h - HEADER) * 0.46f, h - HEADER - rows * (minTile + GAP)))
    val tileH = if (rows == 0) 0f else (h - HEADER - heroH) / rows - GAP
    val tileW = (w - GAP * (cols - 1)) / cols
    Column(GlanceModifier.fillMaxSize()) {
        Header(ui, compact = false)
        Hero(ui, stats.first(), w, heroH, bare = false)
        for (r in 0 until rows) {
            Spacer(GlanceModifier.height(GAP.dp))
            Row(GlanceModifier.fillMaxWidth().defaultWeight()) {
                for (c in 0 until cols) {
                    if (c > 0) Spacer(GlanceModifier.width(GAP.dp))
                    val s = rest.getOrNull(r * cols + c)
                    if (s != null) Tile(ui, s, tileW, tileH, GlanceModifier.defaultWeight())
                    else Spacer(GlanceModifier.defaultWeight())
                }
            }
        }
    }
}

/**
 * All projects: one row per project, busiest first. Rows stretch to fill the widget when they all fit, and
 * become a scrolling list when they don't.
 * Each stat gets a value column (the first one with its change), headed by the stat labels; wide widgets add a
 * sparkline of the first stat. Narrow ones show only it.
 */
@Composable
private fun Overview(ui: Ui, rows: List<OverviewRow>, total: Int, w: Float, h: Float) {
    val pal = ui.pal
    val showHeader = h >= 100
    val rowH = 40f
    val rowGap = 5f
    val colW = 60f
    val sparkW = 48f
    val nameMin = 84f
    val keys = rows.firstOrNull { it.stats.isNotEmpty() }?.stats ?: emptyList()
    // what fits beside the project name, the sparkline going first when space runs out
    val cols = min(keys.size, max(1, floor((w - 20 - nameMin) / colW).toInt()))
    val spark = w - 20 - nameMin - cols * colW >= sparkW + 6
    val labels = cols > 1 || w >= 220
    val hidden = total - rows.size // the server lists at most 30 projects
    // all rows fit at their normal height: stretch them to fill the widget; otherwise scroll. Glance drops the
    // children of a container past the 10th, so stretched rows get a column of their own and gaps are padding.
    val avail = h - (if (showHeader) HEADER else 0f) - (if (labels) 16f else 0f)
    val fits = rows.size <= MAX_CHILDREN && rows.size * (rowH + rowGap) - rowGap <= avail

    Column(GlanceModifier.fillMaxSize()) {
        // narrow headers have room for the update time only
        if (showHeader) Header(ui, compact = w < 200, extra = if (w < 200) null else "${rows.size} projects" + if (hidden > 0) " of $total" else "")
        if (labels) Row(GlanceModifier.fillMaxWidth().height(16.dp).padding(horizontal = 10.dp), verticalAlignment = Alignment.Top) {
            Text("Project", maxLines = 1, modifier = GlanceModifier.defaultWeight(), style = TextStyle(color = pal.p(pal.faint), fontSize = 9.5.sp))
            if (spark) Spacer(GlanceModifier.width((sparkW + 6).dp))
            keys.take(cols).forEach { s ->
                Text(
                    s.label, maxLines = 1, modifier = GlanceModifier.width(colW.dp),
                    style = TextStyle(color = pal.p(pal.faint), fontSize = 9.5.sp, textAlign = TextAlign.End),
                )
            }
        }
        if (fits) Column(GlanceModifier.fillMaxWidth().defaultWeight()) {
            rows.forEachIndexed { i, row ->
                Column(GlanceModifier.fillMaxWidth().defaultWeight().padding(top = if (i > 0) rowGap.dp else 0.dp)) {
                    OverviewRowView(ui, row, cols, colW, if (spark) sparkW else 0f, GlanceModifier.fillMaxHeight())
                }
            }
        } else LazyColumn(GlanceModifier.fillMaxWidth().defaultWeight()) {
            itemsIndexed(rows, itemId = { _, row -> "${row.accountId}/${row.project.id}".hashCode().toLong() }) { i, row ->
                Column(GlanceModifier.fillMaxWidth().padding(top = if (i > 0) rowGap.dp else 0.dp)) {
                    OverviewRowView(ui, row, cols, colW, if (spark) sparkW else 0f, GlanceModifier.height(rowH.dp))
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.OverviewRowView(ui: Ui, row: OverviewRow, cols: Int, colW: Float, sparkW: Float, sizing: GlanceModifier) {
    val pal = ui.pal
    val lead = row.stats.firstOrNull()
    Row(
        GlanceModifier.fillMaxWidth().then(sizing).background(pal.tile).cornerRadius(14.dp).padding(horizontal = 10.dp)
            .clickable(ui.open(lead?.page ?: "overview", row.project.id, row.accountId)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(GlanceModifier.defaultWeight()) {
            Text(row.project.name, maxLines = 1, style = TextStyle(color = pal.p(pal.text), fontSize = 13.sp, fontWeight = FontWeight.Bold))
            if (row.error != null) Text(row.error, maxLines = 1, style = TextStyle(color = pal.p(pal.warn), fontSize = 10.sp))
            else if (ui.multi) Text(ui.label(row), maxLines = 1, style = TextStyle(color = pal.p(pal.faint), fontSize = 10.sp))
            else if (cols == 1 && lead != null) Text(lead.label, maxLines = 1, style = TextStyle(color = pal.p(pal.faint), fontSize = 10.sp))
        }
        if (sparkW > 0 && lead != null && lead.series.size >= 2) {
            Sparkline.render(ui.ctx, lead.series, sparkW, 22f, pal.spark(lead.key, lead.rating, lead.better), zeroBased = lead.unit == "count")?.let {
                Image(ImageProvider(it), contentDescription = null, modifier = GlanceModifier.size(sparkW.dp, 22.dp), contentScale = ContentScale.FillBounds)
            }
            Spacer(GlanceModifier.width(6.dp))
        } else if (sparkW > 0) Spacer(GlanceModifier.width((sparkW + 6).dp))
        row.stats.take(cols).forEachIndexed { i, s ->
            Column(GlanceModifier.width(colW.dp), horizontalAlignment = Alignment.End) {
                Text(
                    Fmt.value(s), maxLines = 1,
                    style = TextStyle(
                        color = pal.p(ratingOr(pal, s)), fontSize = if (i == 0) 15.sp else 13.sp,
                        fontWeight = FontWeight.Bold, textAlign = TextAlign.End,
                    ),
                )
                if (i == 0) Fmt.delta(s)?.let {
                    Text(it.label, maxLines = 1, style = TextStyle(color = pal.p(pal.tone(it.tone)), fontSize = 9.5.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End))
                }
            }
        }
    }
}

// ------------------------------------------------------------------ pieces

@Composable
private fun Header(ui: Ui, compact: Boolean, extra: String? = null) {
    val pal = ui.pal
    val data = ui.data
    val time = if (data.updatedAt > 0) DateFormat.getTimeFormat(ui.ctx).format(Date(data.updatedAt)) else null
    val sub = when {
        data.error != null -> listOfNotNull(data.error, time).joinToString(" · ")
        compact -> time ?: ui.config.range
        else -> listOfNotNull(Fmt.rangeLabel(ui.config.range), time?.let { "updated $it" }).joinToString(" · ")
    }.let { if (extra != null && data.error == null) "$it · $extra" else it }
    Column(GlanceModifier.fillMaxWidth().height(HEADER.dp)) {
        Row(GlanceModifier.fillMaxWidth().height((HEADER - 8).dp), verticalAlignment = Alignment.CenterVertically) { // 2 text lines
            Image(ImageProvider(R.drawable.ic_wgo_mark), contentDescription = null, modifier = GlanceModifier.size(if (compact) 16.dp else 20.dp))
            Spacer(GlanceModifier.width(8.dp))
            Column(GlanceModifier.defaultWeight().clickable(ui.configure())) {
                Text(
                    ui.data.summary?.project?.name ?: ui.config.projectName,
                    maxLines = 1,
                    style = TextStyle(color = pal.p(pal.text), fontSize = if (compact) 11.sp else 13.sp, fontWeight = FontWeight.Bold),
                )
                Text(
                    sub,
                    maxLines = 1,
                    style = TextStyle(color = pal.p(if (data.error != null) pal.warn else pal.faint), fontSize = 10.sp),
                )
            }
            Box(
                GlanceModifier.size(28.dp).cornerRadius(14.dp).clickable(actionRunCallback<RefreshAction>()),
                contentAlignment = Alignment.Center,
            ) {
                if (data.refreshing) CircularProgressIndicator(GlanceModifier.size(14.dp), color = pal.p(pal.accent))
                else Image(
                    ImageProvider(R.drawable.ic_refresh), contentDescription = "Refresh",
                    modifier = GlanceModifier.size(16.dp), colorFilter = ColorFilter.tint(pal.p(pal.muted)),
                )
            }
        }
    }
}

@Composable
private fun Hero(ui: Ui, s: WidgetStat, w: Float, h: Float, bare: Boolean, size: GlanceModifier = GlanceModifier.fillMaxWidth().height(h.dp)) {
    val pal = ui.pal
    val inner = if (bare) 0f else 12f
    val modifier = size.clickable(ui.open(s.page))
    Column(if (bare) modifier else modifier.background(pal.tile).cornerRadius(18.dp).padding(horizontal = inner.dp, vertical = 10.dp)) {
        LabelRow(ui, s, big = true)
        if (s.unit == "text") {
            Text(Fmt.text(s), maxLines = 2, style = TextStyle(color = pal.p(pal.text), fontSize = 20.sp, fontWeight = FontWeight.Bold))
            Fmt.textDetail(s)?.let { Text(it, style = TextStyle(color = pal.p(pal.muted), fontSize = 12.sp)) }
        } else {
            val big = if (h >= 120) 34.sp else if (h >= 80) 28.sp else 22.sp
            Text(Fmt.value(s), maxLines = 1, style = TextStyle(color = pal.p(ratingOr(pal, s)), fontSize = big, fontWeight = FontWeight.Bold))
            val sparkH = h - (if (bare) 0f else 20f) - 18f - big.value * 1.3f - 4f
            Spark(ui, s, w - 2 * inner, sparkH)
        }
    }
}

@Composable
private fun Tile(ui: Ui, s: WidgetStat, w: Float, h: Float, modifier: GlanceModifier) {
    val pal = ui.pal
    Column(
        modifier.fillMaxHeight().background(pal.tile).cornerRadius(16.dp).padding(horizontal = 10.dp, vertical = 8.dp).clickable(ui.open(s.page)),
    ) {
        LabelRow(ui, s, big = false, delta = false) // the delta sits by the value, so the label gets the full width
        if (s.unit == "text") {
            Text(Fmt.text(s), maxLines = 1, style = TextStyle(color = pal.p(pal.text), fontSize = 14.sp, fontWeight = FontWeight.Bold))
            Fmt.textDetail(s)?.let { Text(it, maxLines = 1, style = TextStyle(color = pal.p(pal.faint), fontSize = 10.5.sp)) }
        } else {
            val size = if (w >= 110) 20.sp else 17.sp
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    Fmt.value(s), maxLines = 1, modifier = GlanceModifier.defaultWeight(),
                    style = TextStyle(color = pal.p(ratingOr(pal, s)), fontSize = size, fontWeight = FontWeight.Bold),
                )
                Fmt.delta(s)?.let { DeltaChip(pal, it) }
            }
            Spark(ui, s, w - 20, h - 16 - 16 - size.value * 1.3f - 2)
        }
    }
}

@Composable
private fun ListRow(ui: Ui, s: WidgetStat, w: Float, h: Float) {
    val pal = ui.pal
    Row(
        GlanceModifier.fillMaxWidth().height(h.dp).background(pal.tile).cornerRadius(14.dp).padding(horizontal = 10.dp).clickable(ui.open(s.page)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(GlanceModifier.defaultWeight()) {
            Text(s.label, maxLines = 1, style = TextStyle(color = pal.p(pal.muted), fontSize = 10.5.sp))
            Text(
                if (s.unit == "text") Fmt.text(s) else Fmt.value(s), maxLines = 1,
                style = TextStyle(color = pal.p(ratingOr(pal, s)), fontSize = 16.sp, fontWeight = FontWeight.Bold),
            )
        }
        Fmt.delta(s)?.let { DeltaChip(pal, it) }
        if (s.unit != "text" && w >= 150 && s.series.size >= 2) {
            Sparkline.render(ui.ctx, s.series, 40f, 22f, ui.pal.spark(s.key, s.rating, s.better), zeroBased = s.unit == "count")?.let {
                Spacer(GlanceModifier.width(6.dp))
                Image(ImageProvider(it), contentDescription = null, modifier = GlanceModifier.size(40.dp, 22.dp), contentScale = ContentScale.FillBounds)
            }
        }
    }
}

@Composable
private fun LabelRow(ui: Ui, s: WidgetStat, big: Boolean, delta: Boolean = true) {
    val pal = ui.pal
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (s.key == "visitors_now") {
            Image(
                ImageProvider(R.drawable.dot), contentDescription = null,
                modifier = GlanceModifier.size(7.dp), colorFilter = ColorFilter.tint(pal.p(pal.good)),
            )
            Spacer(GlanceModifier.width(5.dp))
        }
        Text(
            s.label, maxLines = 1, modifier = GlanceModifier.defaultWeight(),
            style = TextStyle(color = pal.p(pal.muted), fontSize = if (big) 12.sp else 10.5.sp, fontWeight = FontWeight.Medium),
        )
        when {
            s.key == "visitors_now" && big -> Text("LIVE", style = TextStyle(color = pal.p(pal.good), fontSize = 9.5.sp, fontWeight = FontWeight.Bold))
            delta -> Fmt.delta(s)?.let { DeltaChip(pal, it) }
        }
    }
}

@Composable
private fun DeltaChip(pal: Palette, d: Fmt.Delta) {
    val c = pal.tone(d.tone)
    Box(GlanceModifier.background(c.copy(alpha = 0.16f)).cornerRadius(6.dp).padding(horizontal = 5.dp, vertical = 1.dp)) {
        Text(d.label, maxLines = 1, style = TextStyle(color = pal.p(c), fontSize = 9.5.sp, fontWeight = FontWeight.Bold))
    }
}

/**
 * Takes the remaining height of its column (defaultWeight), so it can never push past the tile's padding,
 * whatever the launcher's real cell size is. [h] only sizes the bitmap.
 */
@Composable
private fun ColumnScope.Spark(ui: Ui, s: WidgetStat, w: Float, h: Float) {
    if (h < 12 || s.series.size < 2) return
    val bmp = Sparkline.render(
        ui.ctx, s.series, w, h, ui.pal.spark(s.key, s.rating, s.better),
        zeroBased = s.unit == "count",
    ) ?: return
    Spacer(GlanceModifier.height(4.dp))
    Image(
        ImageProvider(bmp), contentDescription = null,
        modifier = GlanceModifier.fillMaxWidth().defaultWeight(), contentScale = ContentScale.FillBounds,
    )
}

@Composable
private fun Prompt(pal: Palette, title: String, body: String, action: Action) {
    Column(
        GlanceModifier.fillMaxSize().clickable(action),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(ImageProvider(R.drawable.ic_wgo_mark), contentDescription = null, modifier = GlanceModifier.size(28.dp))
        Spacer(GlanceModifier.height(8.dp))
        Text(title, maxLines = 1, style = TextStyle(color = pal.p(pal.text), fontSize = 14.sp, fontWeight = FontWeight.Bold))
        Text(body, maxLines = 2, style = TextStyle(color = pal.p(pal.muted), fontSize = 11.sp))
    }
}

private fun ratingOr(pal: Palette, s: WidgetStat): Color = pal.rating(s.rating) ?: pal.text
