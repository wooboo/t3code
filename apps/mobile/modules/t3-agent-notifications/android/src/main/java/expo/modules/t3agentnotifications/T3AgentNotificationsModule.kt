package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")
    Events("voicePushChanged")
    OnCreate {
      val changed: (String) -> Unit = { instance -> sendEvent("voicePushChanged", mapOf("instance" to instance)) }
      VoiceUnifiedPush.onChanged = changed
      VoiceFcmPush.onChanged = changed
    }
    OnDestroy { VoiceUnifiedPush.onChanged = null; VoiceFcmPush.onChanged = null }

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.configure(it, deviceId, userId, scheme, ongoingEnabled)
      }
    }

    Function("configureVoiceCalls") { scheme: String ->
      appContext.reactContext?.let { VoiceCallNotifications.configure(it, scheme) }
    }
    Function("getVoiceFcmState") { instance: String ->
      VoiceFcmPush.state(requireNotNull(appContext.reactContext), instance)
    }
    AsyncFunction("registerVoiceFcm") { instance: String, projectId: String, promise: Promise ->
      VoiceFcmPush.register(requireNotNull(appContext.reactContext), instance, projectId, promise)
    }.runOnQueue(Queues.MAIN)
    Function("unregisterVoiceFcm") { instance: String ->
      appContext.reactContext?.let { VoiceFcmPush.disable(it, instance) }
    }
    Function("getVoicePushState") { instance: String ->
      VoiceUnifiedPush.state(requireNotNull(appContext.reactContext), instance)
    }
    AsyncFunction("registerVoicePush") { instance: String, vapid: String, pick: Boolean, interactive: Boolean, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) promise.reject("NO_ACTIVITY", "Otwórz aplikację, aby włączyć oddzwanianie.", null)
      else VoiceUnifiedPush.register(activity, instance, vapid, pick, interactive, promise)
    }.runOnQueue(Queues.MAIN)
    Function("unregisterVoicePush") { instance: String ->
      appContext.reactContext?.let { VoiceUnifiedPush.unregister(it, instance) }
    }
    Function("setIncomingCallVisible") { visible: Boolean ->
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread { VoiceCallWindow.setVisible(activity, visible) }
      }
    }
    Function("dismissVoiceCall") {
      appContext.reactContext?.let { VoiceCallNotifications.dismiss(it) }
    }
    Function("clear") {
      appContext.reactContext?.let { AgentNotifications.clear(it) }
    }

    Function("showShowcaseActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.showcase(it, scheme, data) }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    Function("openLiveUpdateSettings") {
      val context = appContext.reactContext
      if (context == null || Build.VERSION.SDK_INT < 36) {
        false
      } else {
        try {
          context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }
  }
}
