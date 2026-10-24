package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

/** Data pushes can ring without the React Native runtime or a WebSocket connection. */
object VoiceCallNotifications {
  private const val CHANNEL = "voice-incoming"
  private const val ID = 74001
  private const val STORE = "t3-voice-incoming"

  fun configure(context: Context, scheme: String) {
    require(scheme.matches(Regex("[a-z][a-z0-9+.-]*")))
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().putString("scheme", scheme).apply()
  }

  fun dismiss(context: Context) {
    NotificationManagerCompat.from(context).cancel(ID)
  }

  fun receiveResult(context: Context, data: Map<String, String>) {
    val createdAt = data["createdAt"]?.toLongOrNull() ?: return
    if (System.currentTimeMillis() - createdAt !in -60_000L..86_400_000L) return
    val messageId = data["messageId"]?.takeIf { it.matches(Regex("[a-zA-Z0-9:-]{1,128}")) } ?: return
    val host = data["hostEnvironmentId"]?.takeIf { it.isNotBlank() && it.length <= 4096 } ?: return
    val environment = data["environmentId"]?.takeIf { it.isNotBlank() && it.length <= 4096 } ?: return
    val thread = data["threadId"]?.takeIf { it.isNotBlank() && it.length <= 4096 } ?: return
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val scheme = prefs.getString("scheme", null) ?: return
    val key = "$host:$messageId"
    val seen = prefs.getString("seenResults", "").orEmpty().split('\n')
    if (key in seen) return
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    val channel = "voice-results"
    if (Build.VERSION.SDK_INT >= 26) {
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(channel, "Voice task results", NotificationManager.IMPORTANCE_DEFAULT))
    }
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    intent.action = Intent.ACTION_VIEW
    intent.data = Uri.parse("$scheme:///threads/${Uri.encode(environment)}/${Uri.encode(thread)}")
    intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val notificationId = key.hashCode()
    val open = PendingIntent.getActivity(context, notificationId, intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(context, channel)
      .setSmallIcon(android.R.drawable.sym_action_chat)
      .setContentTitle("Wynik zadania głosowego jest gotowy")
      .setContentText("Otwórz wątek, aby przeczytać wynik. Znajdziesz go również w historii voice.")
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setContentIntent(open)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .build()
    try {
      manager.notify("voice-result", notificationId, notification)
      prefs.edit().putString("seenResults", (seen.takeLast(63) + key).joinToString("\n")).apply()
    } catch (_: SecurityException) { /* Notification permission can be revoked independently. */ }
  }

  fun receive(context: Context, data: Map<String, String>) {
    val expiresAt = data["expiresAt"]?.toLongOrNull() ?: return
    val remaining = expiresAt - System.currentTimeMillis()
    if (remaining <= 0 || remaining > 60_000) return
    val callId = data["callId"]?.takeIf { it.matches(Regex("[a-zA-Z0-9-]{1,128}")) } ?: return
    val host = data["hostEnvironmentId"]?.takeIf { it.isNotBlank() && it.length <= 4096 } ?: return
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val scheme = prefs.getString("scheme", null) ?: return
    if (prefs.getString("lastCall", null) == callId) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = NotificationChannel(CHANNEL, "Incoming voice calls", NotificationManager.IMPORTANCE_HIGH)
      channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
      channel.enableVibration(true)
      manager.createNotificationChannel(channel)
    }
    fun action(value: String, code: Int): PendingIntent? {
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      intent.action = Intent.ACTION_VIEW
      intent.data = Uri.parse("$scheme:///voice-calls/${Uri.encode(host)}/$callId?action=$value")
      intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val open = action("view", 74002) ?: return
    val answer = action("answer", 74003) ?: return
    val decline = action("decline", 74004) ?: return
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(android.R.drawable.sym_action_call)
      .setContentTitle("T3 Code")
      .setContentText("Agent dzwoni")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setContentIntent(open)
      .setFullScreenIntent(open, true)
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(
        Person.Builder().setName("Agent T3 Code").setImportant(true).build(), decline, answer))
      .setTimeoutAfter(remaining)
      .setAutoCancel(true)
      .build()
    notification.flags = notification.flags or android.app.Notification.FLAG_INSISTENT
    try {
      NotificationManagerCompat.from(context).notify(ID, notification)
      prefs.edit().putString("lastCall", callId).apply()
    } catch (_: SecurityException) { /* Notification permission can be revoked independently. */ }
  }
}
