package expo.modules.t3agentnotifications

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** The connector owns encryption keys and distributor IPC; no JS runtime is needed to ring. */
class VoicePushService : PushService() {
  override fun onMessage(message: PushMessage, instance: String) {
    VoiceUnifiedPush.receive(this, message, instance)
  }
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    VoiceUnifiedPush.endpoint(this, endpoint, instance)
  }
  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    VoiceUnifiedPush.failed(this, instance, "UnifiedPush: ${reason.name}")
  }
  override fun onUnregistered(instance: String) {
    VoiceUnifiedPush.disable(this, instance)
  }
  override fun onTempUnavailable(instance: String) {
    VoiceUnifiedPush.failed(this, instance, "Dostawca push jest chwilowo niedostępny.")
  }
}

object VoiceUnifiedPush {
  var onChanged: ((String) -> Unit)? = null
  private const val STORE = "t3-voice-unifiedpush"
  private val main = Handler(Looper.getMainLooper())
  private val generations = mutableMapOf<String, Int>()
  private val waiting = mutableMapOf<String, MutableList<Promise>>()
  private fun prefs(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
  fun state(context: Context, instance: String): String = JSONObject().apply {
    put("enabled", prefs(context).getBoolean("enabled:$instance", false))
    put("error", prefs(context).getString("error:$instance", ""))
    prefs(context).getString("endpoint:$instance", null)?.let { put("subscription", JSONObject(it)) }
  }.toString()

  fun register(activity: Activity, instance: String, vapid: String, pick: Boolean, interactive: Boolean, promise: Promise) {
    if (UnifiedPush.getDistributors(activity).isEmpty()) {
      promise.reject("NO_DISTRIBUTOR", "Zainstaluj i skonfiguruj ntfy, aby odbierać połączenia.", null)
      return
    }
    if (!interactive && UnifiedPush.getAckDistributor(activity) == null) {
      promise.reject("PUSH_SELECTION_REQUIRED", "Wybierz dostawcę push w ustawieniach oddzwaniania.", null)
      return
    }
    val generation = synchronized(this) { generations[instance] ?: 0 }
    val ready: (Boolean) -> Unit = { success ->
      if (!success) promise.reject("NO_DISTRIBUTOR", "Nie wybrano dostawcy UnifiedPush.", null)
      else synchronized(this) {
        if ((generations[instance] ?: 0) != generation) {
          promise.reject("PUSH_DISABLED", "Oddzwanianie wyłączone.", null)
        } else {
        prefs(activity).edit().putBoolean("enabled:$instance", true).remove("error:$instance").apply()
        waiting.getOrPut(instance) { mutableListOf() }.add(promise)
        main.postDelayed({
          if (waiting[instance]?.remove(promise) == true)
            promise.reject("PUSH_TIMEOUT", "Dostawca push nie odpowiedział. Sprawdź ntfy i ponów rejestrację.", null)
        }, 15000)
        try {
          UnifiedPush.register(activity, instance = instance, messageForDistributor = "Połączenia głosowe T3 Code", vapid = vapid)
        } catch (_: Exception) { failed(activity, instance, "Nie można zarejestrować UnifiedPush.") }
        }
      }
    }
    if (pick) UnifiedPush.tryPickDistributor(activity, ready)
    else UnifiedPush.tryUseCurrentOrDefaultDistributor(activity, ready)
  }
  @Synchronized
  fun endpoint(context: Context, endpoint: PushEndpoint, instance: String) {
    // A delayed reply after disabling must not re-enable callbacks.
    if (!prefs(context).getBoolean("enabled:$instance", false)) return
    val keys = endpoint.pubKeySet ?: return failed(context, instance, "Brak kluczy szyfrowania push.")
    val subscription = JSONObject().put("endpoint", endpoint.url).put("keys",
      JSONObject().put("p256dh", keys.pubKey).put("auth", keys.auth))
    prefs(context).edit().putString("endpoint:$instance", subscription.toString()).remove("error:$instance").apply()
    main.post { waiting.remove(instance)?.forEach { it.resolve(subscription.toString()) }; onChanged?.invoke(instance) }
  }
  fun failed(context: Context, instance: String, message: String) {
    prefs(context).edit().putString("error:$instance", message).apply()
    main.post { waiting.remove(instance)?.forEach { it.reject("PUSH_FAILED", message, null) } }
  }
  @Synchronized
  fun disable(context: Context, instance: String) {
    generations[instance] = (generations[instance] ?: 0) + 1
    prefs(context).edit().remove("enabled:$instance").remove("endpoint:$instance").remove("error:$instance").apply()
    main.post { waiting.remove(instance)?.forEach { it.reject("PUSH_DISABLED", "Oddzwanianie wyłączone.", null) }; onChanged?.invoke(instance) }
  }
  fun unregister(context: Context, instance: String) {
    disable(context, instance)
    UnifiedPush.unregister(context, instance)
    VoiceCallNotifications.dismiss(context)
  }
  fun receive(context: Context, message: PushMessage, instance: String) {
    if (!message.decrypted || message.content.size > 4096 || !prefs(context).getBoolean("enabled:$instance", false)) return
    try {
      val payload = JSONObject(String(message.content, Charsets.UTF_8))
      if (payload.optString("hostEnvironmentId") != instance) return
      val data = payload.keys().asSequence().associateWith { payload.getString(it) }
      when (payload.optString("t3_kind")) {
        "voice_call" -> VoiceCallNotifications.receive(context, data)
        "voice_result" -> VoiceCallNotifications.receiveResult(context, data)
      }
    } catch (_: Exception) { /* Ignore invalid or unrelated messages. */ }
  }
}
