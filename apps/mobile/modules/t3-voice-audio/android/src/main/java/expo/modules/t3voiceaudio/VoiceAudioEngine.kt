package expo.modules.t3voiceaudio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Base64
import java.util.ArrayDeque
import java.util.LinkedHashMap
import java.util.concurrent.CopyOnWriteArraySet
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.sqrt

object VoiceAudioEngine {
  interface Listener {
    fun onPcm(audio: String, level: Double)
    fun onPlayback(type: String, responseId: String)
    fun onState(status: String, error: String? = null)
    fun onRoute(available: List<String>, selected: String?)
  }

  private data class Chunk(val bytes: ByteArray, val responseId: String)
  private data class Response(
    var firstFrame: Long? = null,
    var lastFrame: Long = 0,
    var complete: Boolean = false,
    var started: Boolean = false,
    var pendingChunks: Int = 0,
  )

  private val lock = Object()
  private val listeners = CopyOnWriteArraySet<Listener>()
  private val chunks = ArrayDeque<Chunk>()
  private val responses = LinkedHashMap<String, Response>()
  @Volatile private var running = false
  @Volatile private var muted = false
  @Volatile private var generation = 0L
  @Volatile private var playbackEpoch = 0L
  private var recorder: AudioRecord? = null
  private var player: AudioTrack? = null
  private var echoCanceler: AcousticEchoCanceler? = null
  private var noiseSuppressor: NoiseSuppressor? = null
  private var audioManager: AudioManager? = null
  private var focusRequest: AudioFocusRequest? = null
  private var legacyFocusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var deviceCallback: AudioDeviceCallback? = null
  private var communicationDeviceListener: AudioManager.OnCommunicationDeviceChangedListener? = null
  private var previousAudioMode: Int? = null
  private var stopService: (() -> Unit)? = null

  fun addListener(listener: Listener) { listeners.add(listener) }
  fun removeListener(listener: Listener) { listeners.remove(listener) }

  @Synchronized
  fun start(context: Context, inputRate: Int, outputRate: Int, onFatalError: () -> Unit) {
    stopInternal(emitStopped = false)
    val token = ++generation
    muted = false
    stopService = onFatalError
    try {
      requestAudioFocus(context)
      // Select the connected headset before opening capture/playback. Manual route
      // changes later in the call remain authoritative.
      if (audioManager?.let { availableAudioRoutes(it).contains("bluetooth") } == true) {
        try {
          setAudioRoute("bluetooth")
        } catch (_: SecurityException) {
          // Phone audio is still usable when Bluetooth permission was declined.
        } catch (_: IllegalStateException) {
          // The headset may disconnect between enumeration and selection.
        }
      }
      val recordBuffer = max(
        AudioRecord.getMinBufferSize(inputRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
        inputRate * 2 / 5,
      )
      val playbackBuffer = max(
        AudioTrack.getMinBufferSize(outputRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT),
        outputRate * 2 / 5,
      )
      val newRecorder = AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        inputRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        recordBuffer,
      )
      recorder = newRecorder
      check(newRecorder.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord initialization failed" }
      val newPlayer = AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(outputRate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        )
        .setBufferSizeInBytes(playbackBuffer)
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
      player = newPlayer
      check(newPlayer.state == AudioTrack.STATE_INITIALIZED) { "AudioTrack initialization failed" }

      if (AcousticEchoCanceler.isAvailable()) {
        echoCanceler = AcousticEchoCanceler.create(newRecorder.audioSessionId)?.also { it.enabled = true }
      }
      if (NoiseSuppressor.isAvailable()) {
        noiseSuppressor = NoiseSuppressor.create(newRecorder.audioSessionId)?.also { it.enabled = true }
      }
      running = true
      newRecorder.startRecording()
      newPlayer.play()
      emitRouteState()
      captureLoop(newRecorder, inputRate, token)
      playbackLoop(newPlayer, token)
    } catch (error: Throwable) {
      running = false
      stopResources()
      abandonAudioFocus()
      emitState("error", error.message ?: "Audio could not start")
      throw error
    }
  }

  fun setMuted(value: Boolean) { muted = value }

  @Synchronized
  fun setAudioRoute(route: String) {
    val manager = audioManager ?: error("Audio call is not active")
    require(route in listOf("earpiece", "speaker", "bluetooth")) { "Unknown audio route" }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val device = manager.availableCommunicationDevices.firstOrNull { routeForDevice(it) == route }
        ?: error("Audio route is not available")
      check(manager.setCommunicationDevice(device)) { "Audio route could not be selected" }
    } else {
      @Suppress("DEPRECATION")
      when (route) {
        "speaker" -> {
          manager.stopBluetoothSco()
          manager.isBluetoothScoOn = false
          manager.isSpeakerphoneOn = true
        }
        "bluetooth" -> {
          check(availableAudioRoutes(manager).contains("bluetooth")) { "Bluetooth audio is not available" }
          manager.isSpeakerphoneOn = false
          manager.startBluetoothSco()
          manager.isBluetoothScoOn = true
        }
        else -> {
          manager.stopBluetoothSco()
          manager.isBluetoothScoOn = false
          manager.isSpeakerphoneOn = false
        }
      }
    }
    emitRouteState()
  }

  fun enqueueAudio(encoded: String, responseId: String) {
    require(responseId.isNotBlank()) { "responseId cannot be blank" }
    val bytes = Base64.decode(encoded, Base64.DEFAULT)
    require(bytes.size % 2 == 0) { "PCM16 audio must contain whole samples" }
    if (!running || bytes.isEmpty()) return
    synchronized(lock) {
      responses.getOrPut(responseId) { Response() }.pendingChunks++
      chunks.add(Chunk(bytes, responseId))
      lock.notifyAll()
    }
  }

  fun finishResponse(responseId: String) {
    synchronized(lock) {
      responses.getOrPut(responseId) { Response() }.complete = true
      lock.notifyAll()
    }
  }

  fun clearPlayback() {
    val cancelled: List<String>
    synchronized(lock) {
      cancelled = responses.keys.toList()
      chunks.clear()
      responses.clear()
      playbackEpoch++
      player?.pause()
      player?.flush()
      if (running) player?.play()
      lock.notifyAll()
    }
    cancelled.forEach { emitPlayback("playback.cancelled", it) }
  }

  @Synchronized
  fun stop() {
    stopInternal(emitStopped = true)
  }

  private fun stopInternal(emitStopped: Boolean) {
    val wasRunning = running
    running = false
    generation++
    clearPlayback()
    synchronized(lock) { lock.notifyAll() }
    stopResources()
    abandonAudioFocus()
    stopService = null
    if (emitStopped && wasRunning) emitState("stopped")
  }

  private fun captureLoop(audioRecord: AudioRecord, rate: Int, token: Long) = thread(
    name = "t3-voice-capture",
    isDaemon = true,
  ) {
    val frame = ByteArray(rate * 40 / 1_000 * 2)
    var offset = 0
    try {
      while (running && generation == token) {
        val count = audioRecord.read(frame, offset, frame.size - offset, AudioRecord.READ_BLOCKING)
        if (count < 0) {
          failSession(token, "Microphone read failed ($count)")
          break
        }
      offset += count
      if (offset == frame.size) {
        if (!muted) {
          val encoded = Base64.encodeToString(frame, Base64.NO_WRAP)
          listeners.forEach { it.onPcm(encoded, normalizedLevel(frame)) }
        }
        offset = 0
      }
      }
    } catch (error: Throwable) {
      if (running && generation == token) failSession(token, error.message ?: "Microphone failed")
    }
  }

  /** Compresses PCM16 RMS above a small voice-call noise floor into 0..1 for UI metering. */
  private fun normalizedLevel(frame: ByteArray): Double {
    var sumSquares = 0.0
    var index = 0
    while (index + 1 < frame.size) {
      val sample = ((frame[index + 1].toInt() shl 8) or (frame[index].toInt() and 0xff)).toShort()
      val amplitude = sample.toDouble() / Short.MAX_VALUE
      sumSquares += amplitude * amplitude
      index += 2
    }
    val rms = sqrt(sumSquares / (frame.size / 2).coerceAtLeast(1))
    val noiseFloor = 0.012
    if (rms <= noiseFloor) return 0.0
    return sqrt(((rms - noiseFloor) / (1.0 - noiseFloor)).coerceIn(0.0, 1.0))
  }

  private fun playbackLoop(audioTrack: AudioTrack, token: Long) = thread(
    name = "t3-voice-playback",
    isDaemon = true,
  ) {
    var framesWritten = 0L
    var observedEpoch = playbackEpoch
    try {
    while (running && generation == token) {
      if (observedEpoch != playbackEpoch) {
        framesWritten = 0L
        observedEpoch = playbackEpoch
      }
      val chunk = synchronized(lock) { chunks.pollFirst() }
      if (chunk != null) {
        val chunkEpoch = observedEpoch
        val startFrame = framesWritten
        var offset = 0
        while (offset < chunk.bytes.size && running && generation == token) {
          val epoch = observedEpoch
          val count = minOf(chunk.bytes.size - offset, audioTrack.sampleRate * 2 / 100)
          val written = synchronized(lock) {
            if (epoch != playbackEpoch || !running || generation != token) 0
            else audioTrack.write(chunk.bytes, offset, count, AudioTrack.WRITE_BLOCKING)
          }
          if (epoch != playbackEpoch) break
          if (written < 0) {
            failSession(token, "Speaker write failed ($written)")
            break
          }
          offset += written
          framesWritten += written / 2
        }
        synchronized(lock) {
          if (chunkEpoch == playbackEpoch) responses[chunk.responseId]?.let {
            if (it.firstFrame == null) it.firstFrame = startFrame
            it.lastFrame = framesWritten
            it.pendingChunks--
          }
        }
      }

      val played = audioTrack.playbackHeadPosition.toLong() and 0xffffffffL
      val receipts = mutableListOf<Pair<String, String>>()
      synchronized(lock) {
        val iterator = responses.iterator()
        while (iterator.hasNext()) {
          val (id, response) = iterator.next()
          val first = response.firstFrame
          if (!response.started && first != null && played > first) {
            response.started = true
            receipts.add("playback.started" to id)
          }
          if (response.complete && response.pendingChunks == 0 &&
            (first == null || played >= response.lastFrame)
          ) {
            receipts.add("playback.ended" to id)
            iterator.remove()
          }
        }
        if (chunk == null && receipts.isEmpty()) lock.wait(10L)
      }
      receipts.forEach { emitPlayback(it.first, it.second) }
    }
    } catch (error: Throwable) {
      if (running && generation == token) failSession(token, error.message ?: "Speaker failed")
    }
  }

  private fun requestAudioFocus(context: Context) {
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audioManager = manager
    previousAudioMode = manager.mode
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    deviceCallback = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = emitRouteState()
      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = emitRouteState()
    }.also { manager.registerAudioDeviceCallback(it, null) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      communicationDeviceListener = AudioManager.OnCommunicationDeviceChangedListener {
        emitRouteState()
      }.also { manager.addOnCommunicationDeviceChangedListener(context.mainExecutor, it) }
    }
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
        emitState("interrupted")
        val stop = stopService
        stop()
        stop?.invoke()
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(
          AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).build(),
        )
        .setOnAudioFocusChangeListener(listener)
        .build()
      check(manager.requestAudioFocus(focusRequest!!) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        "Audio focus was denied"
      }
    } else {
      legacyFocusListener = listener
      @Suppress("DEPRECATION")
      check(manager.requestAudioFocus(listener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT) ==
        AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      ) { "Audio focus was denied" }
    }
  }

  private fun abandonAudioFocus() {
    val manager = audioManager ?: return
    deviceCallback?.let { manager.unregisterAudioDeviceCallback(it) }
    deviceCallback = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      communicationDeviceListener?.let { manager.removeOnCommunicationDeviceChangedListener(it) }
      manager.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      manager.stopBluetoothSco()
      @Suppress("DEPRECATION")
      run { manager.isBluetoothScoOn = false }
      @Suppress("DEPRECATION")
      run { manager.isSpeakerphoneOn = false }
    }
    communicationDeviceListener = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { manager.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      legacyFocusListener?.let { manager.abandonAudioFocus(it) }
    }
    focusRequest = null
    legacyFocusListener = null
    previousAudioMode?.let { manager.mode = it }
    previousAudioMode = null
    audioManager = null
  }

  private fun routeForDevice(device: AudioDeviceInfo): String? = when (device.type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLE_SPEAKER,
    AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
    else -> null
  }

  private fun availableAudioRoutes(manager: AudioManager): List<String> {
    val devices = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.availableCommunicationDevices
    } else {
      manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    }
    val present = devices.mapNotNull(::routeForDevice).toSet()
    return listOf("earpiece", "speaker", "bluetooth").filter(present::contains)
  }

  private fun selectedAudioRoute(manager: AudioManager): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return manager.communicationDevice?.let(::routeForDevice)
    }
    @Suppress("DEPRECATION")
    return when {
      manager.isBluetoothScoOn -> "bluetooth"
      manager.isSpeakerphoneOn -> "speaker"
      else -> "earpiece"
    }
  }

  private fun emitRouteState() {
    val manager = audioManager ?: return
    val available = availableAudioRoutes(manager)
    val selected = selectedAudioRoute(manager) ?: available.firstOrNull()
    listeners.forEach { it.onRoute(available, selected) }
  }

  private fun stopResources() {
    try { recorder?.stop() } catch (_: Throwable) {}
    try { player?.stop() } catch (_: Throwable) {}
    try { echoCanceler?.release() } catch (_: Throwable) {}
    try { noiseSuppressor?.release() } catch (_: Throwable) {}
    try { recorder?.release() } catch (_: Throwable) {}
    try { player?.release() } catch (_: Throwable) {}
    echoCanceler = null
    noiseSuppressor = null
    recorder = null
    player = null
  }

  private fun emitPlayback(type: String, responseId: String) = listeners.forEach {
    it.onPlayback(type, responseId)
  }
  private fun emitState(status: String, error: String? = null) = listeners.forEach {
    it.onState(status, error)
  }

  fun reportError(message: String) = emitState("error", message)

  private fun failSession(token: Long, message: String) {
    if (!running || generation != token) return
    emitState("error", message)
    val stop = stopService
    stop()
    stop?.invoke()
  }
}
