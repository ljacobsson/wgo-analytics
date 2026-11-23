package tools.lars.wgo.ui

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer

class QrDecoderTest {
    private val link = "https://wgo.example.com/pair.html#api=https%3A%2F%2Fapi.wgo.example.com&token=dt_abcdefghijklmnopqrstuvwxyz0123456789"

    /** A camera-like luminance frame: the QR code drawn mid-frame on grey, rows padded to [rowStride]. */
    private fun frame(text: String, width: Int, height: Int, rowStride: Int, qrSize: Int): ByteBuffer {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, qrSize, qrSize, mapOf(EncodeHintType.MARGIN to 4))
        val left = (width - qrSize) / 2
        val top = (height - qrSize) / 2
        // the last row stops at width, like many camera HALs
        val bytes = ByteArray(rowStride * (height - 1) + width) { 0x80.toByte() }
        for (y in 0 until qrSize) for (x in 0 until qrSize) {
            bytes[(top + y) * rowStride + left + x] = if (matrix[x, y]) 0x10 else 0xF0.toByte()
        }
        return ByteBuffer.wrap(bytes)
    }

    @Test fun decodesPairingLinkFromPaddedFrame() {
        val decoder = QrDecoder()
        assertEquals(link, decoder.decode(frame(link, 1280, 720, 1344, 420), 1344, 1280, 720))
        // the same decoder keeps working across frames of another size
        assertEquals(link, decoder.decode(frame(link, 640, 480, 640, 300), 640, 640, 480))
    }

    @Test fun returnsNullWithoutQrCode() {
        val blank = ByteBuffer.wrap(ByteArray(640 * 480) { 0x80.toByte() })
        assertNull(QrDecoder().decode(blank, 640, 640, 480))
    }
}
