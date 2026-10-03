package expo.modules.t3voiceaudio

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.PowerManager
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowPowerManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class VoiceCallServiceTest {
  @Test fun livekitRunsInForegroundWithoutStartingTheLegacyRecorderAndReleasesItsWakeLock() {
    val app = RuntimeEnvironment.getApplication()
    var completed = false
    T3VoiceAudioService.start(app, 16_000, 24_000, livekit = true) { error ->
      assertNull(error)
      completed = true
    }
    val intent = shadowOf(app).nextStartedService
    val controller = Robolectric.buildService(T3VoiceAudioService::class.java, intent).create().startCommand(0, 1)
    val service = controller.get()
    assertTrue(completed)
    assertNotNull(shadowOf(service).lastForegroundNotification)
    val wakeLock = ShadowPowerManager.getLatestWakeLock()
    assertTrue(wakeLock.isHeld)
    // The service must leave microphone ownership, focus and routing to LiveKit.
    assertEquals(AudioManager.MODE_NORMAL, (app.getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode)
    val power = app.getSystemService(Context.POWER_SERVICE) as PowerManager
    shadowOf(power).setIsInteractive(false)
    app.sendBroadcast(Intent(Intent.ACTION_SCREEN_OFF))
    assertTrue(wakeLock.isHeld)
    assertNotNull(shadowOf(service).lastForegroundNotification)
    T3VoiceAudioService.setCallMuted(true)
    assertTrue(wakeLock.isHeld)
    var hungUp = false
    T3VoiceAudioService.onCallStopRequested = { hungUp = true }
    service.onStartCommand(Intent(app, T3VoiceAudioService::class.java).setAction("expo.modules.t3voiceaudio.STOP"), 0, 2)
    assertTrue(hungUp)
    assertFalse(wakeLock.isHeld)
    T3VoiceAudioService.onCallStopRequested = null
    controller.destroy()
  }
}
