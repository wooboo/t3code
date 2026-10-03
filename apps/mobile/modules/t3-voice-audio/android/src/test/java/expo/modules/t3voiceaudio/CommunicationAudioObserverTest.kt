package expo.modules.t3voiceaudio

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Looper
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class CommunicationAudioObserverTest {
  @Test fun reportsTheSelectedDeviceInsteadOfTheFirstAvailableAndTracksChanges() {
    val app = RuntimeEnvironment.getApplication()
    val manager = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val speaker = AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER).build()
    val bluetooth = AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_BLUETOOTH_SCO).build()
    val usb = AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_USB_HEADSET).build()
    shadowOf(manager).setAvailableCommunicationDevices(listOf(speaker, bluetooth, usb))
    manager.setCommunicationDevice(bluetooth)
    val events = mutableListOf<Map<String, Any?>>()
    val observer = CommunicationAudioObserver(app) { events.add(it) }
    observer.start()
    assertEquals("bluetooth", observer.snapshot()["selected"])
    assertEquals(listOf("speaker", "bluetooth", "headset"), observer.snapshot()["available"])
    manager.setCommunicationDevice(usb)
    shadowOf(manager).callOnCommunicationDeviceChangedListeners(usb)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals("headset", events.last()["selected"])
    manager.clearCommunicationDevice()
    assertNull(observer.snapshot()["selected"])
    observer.stop()
    val count = events.size
    manager.setCommunicationDevice(speaker)
    shadowOf(manager).callOnCommunicationDeviceChangedListeners(speaker)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(count, events.size)
  }
}
