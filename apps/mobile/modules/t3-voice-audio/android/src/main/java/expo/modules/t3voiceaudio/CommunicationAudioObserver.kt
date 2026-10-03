package expo.modules.t3voiceaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat

/** Observes LiveKit's communication route without acquiring focus or changing routing. */
class CommunicationAudioObserver(private val context: Context, private val emit: (Map<String, Any?>) -> Unit) {
  private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var started = false
  private var communicationListener: AudioManager.OnCommunicationDeviceChangedListener? = null
  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = publish()
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = publish()
  }
  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) = publish()
  }

  private fun route(device: AudioDeviceInfo): String? = when (device.type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "headset"
    else -> null
  }

  @Suppress("DEPRECATION")
  fun snapshot(): Map<String, Any?> {
    val outputs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.availableCommunicationDevices
    } else manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    val available = outputs.mapNotNull(::route).distinct()
    val selected = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.communicationDevice?.let(::route)
    } else when {
      manager.isBluetoothScoOn -> "bluetooth"
      manager.isSpeakerphoneOn -> "speaker"
      "headset" in available -> "headset"
      "earpiece" in available -> "earpiece"
      else -> null
    }
    return mapOf("available" to available, "selected" to selected)
  }

  private fun publish() { if (started) emit(snapshot()) }

  fun start() {
    if (started) return
    started = true
    manager.registerAudioDeviceCallback(devices, Handler(Looper.getMainLooper()))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      communicationListener = AudioManager.OnCommunicationDeviceChangedListener { publish() }
        .also { manager.addOnCommunicationDeviceChangedListener(context.mainExecutor, it) }
    } else {
      val filter = IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) filter.addAction(AudioManager.ACTION_SPEAKERPHONE_STATE_CHANGED)
      ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }
    publish()
  }

  fun stop() {
    if (!started) return
    started = false
    manager.unregisterAudioDeviceCallback(devices)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      communicationListener?.let { manager.removeOnCommunicationDeviceChangedListener(it) }
      communicationListener = null
    } else context.unregisterReceiver(receiver)
  }
}
