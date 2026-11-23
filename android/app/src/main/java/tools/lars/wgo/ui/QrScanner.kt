package tools.lars.wgo.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Size
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContract
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size as GeoSize
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.ReaderException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import kotlinx.coroutines.delay
import tools.lars.wgo.data.AccountStore
import tools.lars.wgo.data.Pairing
import java.nio.ByteBuffer
import java.util.concurrent.Executors

/** Full-screen camera view that scans the dashboard's pairing QR code and returns the first valid connection link. */
class QrScanActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        setContent {
            WgoTheme {
                QrScannerScreen(
                    onResult = { link -> setResult(RESULT_OK, Intent().putExtra(EXTRA_LINK, link)); finish() },
                    onDismiss = ::finish,
                )
            }
        }
    }

    /** Launches the scanner; yields the scanned connection link, or null when cancelled. Needs the CAMERA permission. */
    class Contract : ActivityResultContract<Unit, Pairing?>() {
        override fun createIntent(context: Context, input: Unit) = Intent(context, QrScanActivity::class.java)
        override fun parseResult(resultCode: Int, intent: Intent?): Pairing? =
            if (resultCode == RESULT_OK) AccountStore.parsePairing(intent?.getStringExtra(EXTRA_LINK)) else null
    }

    private companion object {
        const val EXTRA_LINK = "link"
    }
}

@Composable
private fun QrScannerScreen(onResult: (String) -> Unit, onDismiss: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    var wrongCode by remember { mutableStateOf(0L) } // when a non-WGO QR code was last seen
    var cameraError by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }

    LaunchedEffect(wrongCode) {
        if (wrongCode != 0L) { delay(2500); wrongCode = 0L }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        CameraPreview(
            onCode = { text ->
                if (done) return@CameraPreview
                if (AccountStore.parsePairing(text) == null) wrongCode = System.currentTimeMillis()
                else {
                    done = true
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onResult(text)
                }
            },
            onError = { cameraError = true },
        )
        Viewfinder()
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Scan the QR code", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "Close", tint = Color.White) }
            }
            Spacer(Modifier.weight(1f))
            Text(
                when {
                    cameraError -> "Couldn't open the camera. Paste the connection link instead."
                    wrongCode != 0L -> "That QR code isn't a WGO connection link."
                    else -> "In your dashboard, open Mobile widget and tap Connect a device. Point the camera at the QR code it shows."
                },
                color = if (cameraError || wrongCode != 0L) Brand.warn else Color.White.copy(alpha = 0.85f),
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 16.dp),
            )
        }
    }
}

/** Dims everything outside a centred square and outlines it. */
@Composable
private fun Viewfinder() {
    Box(
        Modifier
            .fillMaxSize()
            .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
            .drawWithContent {
                val side = minOf(size.width, size.height) * 0.68f
                val topLeft = Offset((size.width - side) / 2, (size.height - side) / 2)
                val corner = CornerRadius(24.dp.toPx())
                drawRect(Color.Black.copy(alpha = 0.55f))
                drawRoundRect(Color.Transparent, topLeft, GeoSize(side, side), corner, blendMode = BlendMode.Clear)
                drawRoundRect(Brand.gradient, topLeft, GeoSize(side, side), corner, style = Stroke(3.dp.toPx()))
            },
    )
}

@Composable
private fun CameraPreview(onCode: (String) -> Unit, onError: () -> Unit) {
    val ctx = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnCode by rememberUpdatedState(onCode)
    val currentOnError by rememberUpdatedState(onError)
    val previewView = remember { PreviewView(ctx).apply {
        scaleType = PreviewView.ScaleType.FILL_CENTER
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE // TextureView, so the overlay draws on top
    } }

    DisposableEffect(lifecycleOwner) {
        val executor = Executors.newSingleThreadExecutor()
        val mainExecutor = ContextCompat.getMainExecutor(ctx)
        val decoder = QrDecoder()
        val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                    .build(),
            )
            .build()
            .also { a ->
                a.setAnalyzer(executor) { image ->
                    val text = image.use(decoder::decode)
                    if (text != null) mainExecutor.execute { currentOnCode(text) }
                }
            }
        var provider: ProcessCameraProvider? = null
        val future = ProcessCameraProvider.getInstance(ctx)
        future.addListener({
            try {
                provider = future.get().also {
                    it.unbindAll()
                    it.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }
            } catch (e: Exception) {
                currentOnError()
            }
        }, mainExecutor)
        onDispose {
            provider?.unbind(preview, analysis)
            analysis.clearAnalyzer()
            executor.shutdown()
        }
    }

    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
}

/** ZXing QR decoding of the luminance (Y) plane of a camera frame. QR codes decode at any rotation. */
internal class QrDecoder {
    private val reader = QRCodeReader()
    private val hints = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
    )
    private var buffer = ByteArray(0)

    fun decode(image: ImageProxy): String? = image.planes[0].let { decode(it.buffer, it.rowStride, image.width, image.height) }

    /** [luma]: one byte per pixel, rows [rowStride] bytes apart (the last row may be shorter). */
    fun decode(luma: ByteBuffer, rowStride: Int, width: Int, height: Int): String? {
        val size = rowStride * height
        if (buffer.size != size) buffer = ByteArray(size)
        val src = luma.duplicate().apply { rewind() }
        src.get(buffer, 0, minOf(src.remaining(), size))
        val source = PlanarYUVLuminanceSource(buffer, rowStride, height, 0, 0, width, height, false)
        return try {
            reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
        } catch (_: ReaderException) {
            null
        } finally {
            reader.reset()
        }
    }
}
