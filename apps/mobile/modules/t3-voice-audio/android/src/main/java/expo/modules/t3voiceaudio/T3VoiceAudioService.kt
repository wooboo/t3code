package expo.modules.t3voiceaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.util.concurrent.atomic.AtomicLong

class T3VoiceAudioService : Service() {
  private var livekitSession = false
  private var muted = false
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    activeService = this
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        if (livekitSession) onCallStopRequested?.invoke()
        stopSession()
        return START_NOT_STICKY
      }
      ACTION_START -> {
        synchronized(lifecycleLock) {
          if (intent.getLongExtra(EXTRA_GENERATION, -1L) != desiredGeneration.get()) {
            completeStart(intent.getLongExtra(EXTRA_GENERATION, -1L), IllegalStateException("Audio start was superseded"))
            stopSelfResult(startId)
            return START_NOT_STICKY
          }
          var engineInvoked = false
          try {
            livekitSession = intent.getBooleanExtra(EXTRA_LIVEKIT, false)
            muted = false
            val notification = notification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
              startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
              startForeground(NOTIFICATION_ID, notification)
            }
            acquireWakeLock()
            if (!livekitSession) {
              engineInvoked = true
              VoiceAudioEngine.start(
                applicationContext,
                intent.getIntExtra(EXTRA_INPUT_RATE, 16_000),
                intent.getIntExtra(EXTRA_OUTPUT_RATE, 24_000),
              ) { stopSession() }
            }
            completeStart(intent.getLongExtra(EXTRA_GENERATION, -1L), null)
          } catch (error: Throwable) {
            if (!livekitSession && !engineInvoked) {
              VoiceAudioEngine.reportError(error.message ?: "Nie udało się uruchomić rozmowy głosowej")
            }
            completeStart(intent.getLongExtra(EXTRA_GENERATION, -1L), error)
            stopSession()
          }
        }
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    if (!livekitSession) VoiceAudioEngine.stop()
    if (activeService === this) activeService = null
    releaseWakeLock()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "t3code:voice-session").also {
      it.setReferenceCounted(false)
      it.acquire()
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun stopSession() {
    synchronized(lifecycleLock) {
      desiredGeneration.incrementAndGet()
      rejectPendingStarts(IllegalStateException("Audio start was stopped"))
      if (!livekitSession) VoiceAudioEngine.stop()
      releaseWakeLock()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(CHANNEL_ID, "Rozmowa głosowa", NotificationManager.IMPORTANCE_LOW)
    channel.description = "Nagrywanie dźwięku podczas rozmowy głosowej"
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun updateMuted(value: Boolean) {
    muted = value
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
  }

  private fun notification(): Notification {
    val stopIntent = Intent(this, T3VoiceAudioService::class.java).setAction(ACTION_STOP)
    val stopPendingIntent = PendingIntent.getService(
      this,
      1,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("T3 Code — rozmowa głosowa")
      .setContentText(if (muted) "Mikrofon wyciszony" else "Rozmowa w toku — mikrofon aktywny")
      .setContentIntent(packageManager.getLaunchIntentForPackage(packageName)?.let {
        PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      })
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_CALL)
      .addAction(
        Notification.Action.Builder(
          android.R.drawable.ic_media_pause,
          "Zakończ rozmowę",
          stopPendingIntent,
        ).build(),
      )
      .build()
  }

  companion object {
    private var activeService: T3VoiceAudioService? = null
    var onCallStopRequested: (() -> Unit)? = null
    fun setCallMuted(muted: Boolean) { activeService?.updateMuted(muted) }
    private const val EXTRA_LIVEKIT = "livekit"
    private const val CHANNEL_ID = "t3_voice_audio"
    private const val NOTIFICATION_ID = 7301
    private const val ACTION_START = "expo.modules.t3voiceaudio.START"
    private const val ACTION_STOP = "expo.modules.t3voiceaudio.STOP"
    private const val EXTRA_INPUT_RATE = "inputRate"
    private const val EXTRA_OUTPUT_RATE = "outputRate"
    private const val EXTRA_GENERATION = "generation"
    private val desiredGeneration = AtomicLong(0)
    private val lifecycleLock = Object()
    private val pendingStarts = LinkedHashMap<Long, (Throwable?) -> Unit>()

    fun start(context: Context, inputRate: Int, outputRate: Int, livekit: Boolean = false, completion: (Throwable?) -> Unit) {
      synchronized(lifecycleLock) {
        rejectPendingStarts(IllegalStateException("Audio start was superseded"))
        val generation = desiredGeneration.incrementAndGet()
        pendingStarts[generation] = completion
        val intent = Intent(context, T3VoiceAudioService::class.java)
          .setAction(ACTION_START)
          .putExtra(EXTRA_LIVEKIT, livekit)
          .putExtra(EXTRA_INPUT_RATE, inputRate)
          .putExtra(EXTRA_OUTPUT_RATE, outputRate)
          .putExtra(EXTRA_GENERATION, generation)
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
          } else {
            context.startService(intent)
          }
        } catch (error: Throwable) {
          completeStart(generation, error)
        }
      }
    }

    fun stop(context: Context) {
      synchronized(lifecycleLock) {
        desiredGeneration.incrementAndGet()
        rejectPendingStarts(IllegalStateException("Audio start was stopped"))
        if (activeService?.livekitSession != true) VoiceAudioEngine.stop()
        context.stopService(Intent(context, T3VoiceAudioService::class.java))
      }
    }

    private fun completeStart(generation: Long, error: Throwable?) {
      pendingStarts.remove(generation)?.invoke(error)
    }

    private fun rejectPendingStarts(error: Throwable) {
      val completions = pendingStarts.values.toList()
      pendingStarts.clear()
      completions.forEach { it(error) }
    }
  }
}
