package expo.modules.t3agentnotifications

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.kotlin.Promise
import org.json.JSONObject

/** Persist opt-in so cold-start delivery never depends on the JavaScript runtime. */
object VoiceFcmPush {
  private const val STORE = "t3-voice-fcm"
  var onChanged: ((String) -> Unit)? = null
  private val generations = mutableMapOf<String, Int>()
  private fun prefs(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  fun state(context: Context, instance: String): String = JSONObject().apply {
    val saved = prefs(context)
    put("enabled", saved.getBoolean("enabled:$instance", false))
    put("error", "")
    saved.getString("token", null)?.let { put("token", it) }
    saved.getString("project:$instance", null)?.let { put("projectId", it) }
  }.toString()

  @Synchronized
  fun register(context: Context, instance: String, projectId: String, promise: Promise) {
    try {
      if (FirebaseApp.getInstance().options.projectId != projectId) {
        promise.reject("FCM_PROJECT", "Ta wersja aplikacji używa innego projektu Firebase. Zaktualizuj aplikację.", null)
        return
      }
      val generation = generations[instance] ?: 0
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        synchronized(this) {
          if ((generations[instance] ?: 0) != generation) {
            promise.reject("FCM_DISABLED", "Oddzwanianie wyłączone.", null)
          } else if (!task.isSuccessful || task.result.isNullOrBlank()) {
            promise.reject("FCM_TOKEN", "Nie udało się zarejestrować telefonu w Firebase.", null)
          } else {
            prefs(context).edit().putBoolean("enabled:$instance", true)
              .putString("project:$instance", projectId).putString("token", task.result).apply()
            promise.resolve(task.result)
          }
        }
      }
    } catch (_: Exception) {
      promise.reject("FCM_CONFIG", "Ta wersja aplikacji nie ma konfiguracji Firebase. Zaktualizuj aplikację.", null)
    }
  }

  @Synchronized
  fun disable(context: Context, instance: String) {
    generations[instance] = (generations[instance] ?: 0) + 1
    prefs(context).edit().remove("enabled:$instance").remove("project:$instance").apply()
    VoiceCallNotifications.dismiss(context)
  }

  fun rotated(context: Context, token: String) {
    val saved = prefs(context)
    saved.edit().putString("token", token).apply()
    saved.all.filter { it.key.startsWith("enabled:") && it.value == true }.keys.forEach {
      onChanged?.invoke(it.removePrefix("enabled:"))
    }
  }

  fun receive(context: Context, data: Map<String, String>) {
    val host = data["hostEnvironmentId"] ?: return
    if (!prefs(context).getBoolean("enabled:$host", false)) return
    when (data["t3_kind"]) {
      "voice_call" -> VoiceCallNotifications.receive(context, data)
      "voice_result" -> VoiceCallNotifications.receiveResult(context, data)
    }
  }
}
