package expo.modules.t3agentnotifications

import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import com.google.firebase.messaging.RemoteMessage
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PublicKeySet
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
class VoiceCallNotificationsTest {
  private lateinit var context: Application
  private lateinit var manager: NotificationManager
  @Before fun setup() {
    context = RuntimeEnvironment.getApplication()
    manager = context.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(true)
    context.getSharedPreferences("t3-voice-incoming", 0).edit().clear().commit()
    val launcher = ComponentName(context, Activity::class.java)
    shadowOf(context.packageManager).addActivityIfNotPresent(launcher)
    shadowOf(context.packageManager).addIntentFilterForActivity(launcher,
      IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) })
    context.getSharedPreferences("t3-voice-fcm", 0).edit().clear().commit()
    VoiceCallNotifications.configure(context, "t3code-dev")
  }
  private fun invitation(expiry: Long = System.currentTimeMillis() + 45_000) = mapOf(
    "callId" to "call-123", "hostEnvironmentId" to "host-123", "expiresAt" to expiry.toString())

  @Test fun `incoming push creates call notification with explicit answer and decline actions`() {
    VoiceCallNotifications.receive(context, invitation())
    val notification = shadowOf(manager).getNotification(74001)
    assertNotNull(notification)
    assertEquals(Notification.CATEGORY_CALL, notification.category)
    assertTrue(notification.flags and Notification.FLAG_INSISTENT != 0)
    assertTrue(notification.timeoutAfter in 1..45_000)
    val open = shadowOf(notification.contentIntent).savedIntent
    assertEquals("t3code-dev:///voice-calls/host-123/call-123?action=view", open.dataString)
    val paths = notification.actions.map { shadowOf(it.actionIntent).savedIntent.dataString }
    assertTrue(paths.any { it?.endsWith("action=answer") == true })
    assertTrue(paths.any { it?.endsWith("action=decline") == true })
    VoiceCallNotifications.dismiss(context)
    assertNull(shadowOf(manager).getNotification(74001))
    VoiceCallNotifications.receive(context, invitation())
    assertNull(shadowOf(manager).getNotification(74001))
  }
  @Test fun `expired or malformed pushes cannot ring`() {
    VoiceCallNotifications.receive(context, invitation(System.currentTimeMillis() - 1))
    VoiceCallNotifications.receive(context, invitation() + ("callId" to "../other"))
    assertNull(shadowOf(manager).getNotification(74001))
  }
  private fun result() = mapOf(
    "t3_kind" to "voice_result", "messageId" to "agent:result-123",
    "hostEnvironmentId" to "host-123", "environmentId" to "remote", "threadId" to "thread-1",
    "createdAt" to System.currentTimeMillis().toString())

  @Test fun `voice result notification persists after ringing ends and opens the originating thread`() {
    context.getSharedPreferences("t3-voice-fcm", 0).edit().putBoolean("enabled:host-123", true).commit()
    VoiceCallNotifications.receive(context, invitation())
    VoiceFcmPush.receive(context, result())
    VoiceCallNotifications.dismiss(context)
    val entry = manager.activeNotifications.single()
    assertEquals("voice-result", entry.tag)
    val notification = entry.notification
    assertEquals(Notification.CATEGORY_MESSAGE, notification.category)
    assertEquals(0L, notification.timeoutAfter)
    assertTrue(notification.flags and Notification.FLAG_INSISTENT == 0)
    assertEquals("t3code-dev:///threads/remote/thread-1", shadowOf(notification.contentIntent).savedIntent.dataString)
    VoiceFcmPush.receive(context, result())
    assertEquals(1, manager.activeNotifications.size)
  }

  @Test fun `UnifiedPush delivers a result without a call and rejects stale or disabled results`() {
    val prefs = context.getSharedPreferences("t3-voice-unifiedpush", 0)
    prefs.edit().putBoolean("enabled:host-123", true).commit()
    val data = JSONObject(result()).toString().toByteArray()
    VoiceUnifiedPush.receive(context, PushMessage(data, true), "host-123")
    assertEquals(1, manager.activeNotifications.size)
    manager.cancelAll()
    VoiceCallNotifications.receiveResult(context, result() + mapOf(
      "messageId" to "agent:stale", "createdAt" to (System.currentTimeMillis() - 86_400_001).toString()))
    VoiceUnifiedPush.disable(context, "host-123")
    VoiceUnifiedPush.receive(context, PushMessage(JSONObject(result() + ("messageId" to "agent:other")).toString().toByteArray(), true), "host-123")
    assertEquals(0, manager.activeNotifications.size)
  }
  @Test fun `UnifiedPush only rings for decrypted messages bound to an enabled host`() {
    context.getSharedPreferences("t3-voice-unifiedpush", 0).edit().putBoolean("enabled:host-123", true).commit()
    val data = JSONObject(invitation()).put("t3_kind", "voice_call").toString().toByteArray()
    VoiceUnifiedPush.receive(context, PushMessage(data, false), "host-123")
    VoiceUnifiedPush.receive(context, PushMessage(data, true), "another-host")
    assertNull(shadowOf(manager).getNotification(74001))
    VoiceUnifiedPush.receive(context, PushMessage(data, true), "host-123")
    assertNotNull(shadowOf(manager).getNotification(74001))
    VoiceCallNotifications.dismiss(context)
    VoiceUnifiedPush.disable(context, "host-123")
    VoiceUnifiedPush.receive(context, PushMessage(data, true), "host-123")
    assertNull(shadowOf(manager).getNotification(74001))
  }
  @Test fun `endpoint rotation persists keys and a late endpoint cannot undo unregister`() {
    val prefs = context.getSharedPreferences("t3-voice-unifiedpush", 0)
    prefs.edit().putBoolean("enabled:host", true).commit()
    VoiceUnifiedPush.endpoint(context, PushEndpoint("https://push.test/old", PublicKeySet("key", "auth"), false), "host")
    VoiceUnifiedPush.endpoint(context, PushEndpoint("https://push.test/new", PublicKeySet("new-key", "new-auth"), false), "host")
    val saved = JSONObject(VoiceUnifiedPush.state(context, "host")).getJSONObject("subscription")
    assertEquals("https://push.test/new", saved.getString("endpoint"))
    assertEquals("new-key", saved.getJSONObject("keys").getString("p256dh"))
    VoiceUnifiedPush.disable(context, "host")
    VoiceUnifiedPush.endpoint(context, PushEndpoint("https://push.test/late", PublicKeySet("key", "auth"), false), "host")
    assertFalse(JSONObject(VoiceUnifiedPush.state(context, "host")).has("subscription"))
  }

  @Test fun `FCM service rings only for an enabled host and stops after disabling`() {
    val service = Robolectric.buildService(AgentMessagingService::class.java).create().get()
    val payload = invitation() + ("t3_kind" to "voice_call")
    val message = RemoteMessage.Builder("sender").setData(payload).build()
    service.onMessageReceived(message)
    assertNull(shadowOf(manager).getNotification(74001))
    context.getSharedPreferences("t3-voice-fcm", 0).edit().putBoolean("enabled:host-123", true).commit()
    service.onMessageReceived(message)
    assertNotNull(shadowOf(manager).getNotification(74001))
    VoiceFcmPush.disable(context, "host-123")
    service.onMessageReceived(RemoteMessage.Builder("sender").setData(payload + ("callId" to "other-call")).build())
    assertNull(shadowOf(manager).getNotification(74001))
  }

  @Test fun `FCM token rotation persists while JavaScript is absent`() {
    VoiceFcmPush.rotated(context, "new-token")
    assertEquals("new-token", JSONObject(VoiceFcmPush.state(context, "host")).getString("token"))
    assertFalse(JSONObject(VoiceFcmPush.state(context, "host")).getBoolean("enabled"))
  }

  @Test fun `incoming screen covers the keyguard and leaving it restores normal lock behavior`() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    val activity = controller.get()
    VoiceCallWindow.setVisible(activity, true)
    assertTrue(shadowOf(activity).getShowWhenLocked())
    assertTrue(shadowOf(activity).getTurnScreenOn())
    VoiceCallWindow.setVisible(activity, false)
    assertFalse(shadowOf(activity).getShowWhenLocked())
    assertFalse(shadowOf(activity).getTurnScreenOn())
    controller.pause().stop().destroy()
  }

}
