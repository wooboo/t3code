package expo.modules.t3voiceaudio

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class StartOptions : Record {
  @Field val inputSampleRate: Int = 16_000
  @Field val outputSampleRate: Int = 24_000
}

class AudioChunk : Record {
  @Field val pcmBase64: String = ""
  @Field val responseId: String = ""
}

class T3VoiceAudioModule : Module() {
  private var callGeneration = 0
  private var callRunning = false
  private val callWaiters = mutableListOf<Promise>()
  private fun finishBackgroundCall() {
    callRunning = false
    val waiters = callWaiters.toList()
    callWaiters.clear()
    waiters.forEach { it.resolve(null) }
  }
  private var routeObserver: CommunicationAudioObserver? = null
  private val listener = object : VoiceAudioEngine.Listener {
    override fun onPcm(audio: String, level: Double) =
      sendEvent("pcm", mapOf("audio" to audio, "level" to level))
    override fun onPlayback(type: String, responseId: String) =
      sendEvent("playback", mapOf("type" to type, "responseId" to responseId))
    override fun onState(status: String, error: String?) = sendEvent(
      "state",
      if (error == null) mapOf("status" to status) else mapOf("status" to status, "error" to error),
    )
    override fun onRoute(available: List<String>, selected: String?) =
      sendEvent("route", mapOf("available" to available, "selected" to selected))
  }

  override fun definition() = ModuleDefinition {
    Name("T3VoiceAudio")
    Events("pcm", "playback", "state", "route", "audioRouteChanged", "callStopRequested")
    OnStartObserving("audioRouteChanged") {
      appContext.reactContext?.let { context ->
        routeObserver = CommunicationAudioObserver(context) { sendEvent("audioRouteChanged", it) }
          .also { it.start() }
      }
    }
    OnStopObserving("audioRouteChanged") {
      routeObserver?.stop()
      routeObserver = null
    }
    AsyncFunction("getAudioRouteState") {
      val context = requireNotNull(appContext.reactContext)
      (routeObserver ?: CommunicationAudioObserver(context) {}).snapshot()
    }

    OnCreate {
      VoiceAudioEngine.addListener(listener)
      T3VoiceAudioService.onCallStopRequested = { sendEvent("callStopRequested", emptyMap<String, Any>()) }
    }
    OnDestroy {
      finishBackgroundCall()
      routeObserver?.stop()
      routeObserver = null
      T3VoiceAudioService.onCallStopRequested = null
      VoiceAudioEngine.removeListener(listener)
      appContext.reactContext?.let { T3VoiceAudioService.stop(it) }
    }

    AsyncFunction("start") { options: StartOptions, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_VOICE_AUDIO_START", "React context is unavailable", null)
        return@AsyncFunction
      }
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
        PackageManager.PERMISSION_GRANTED
      ) {
        promise.reject("ERR_VOICE_AUDIO_PERMISSION", "Microphone permission has not been granted", null)
        return@AsyncFunction
      }
      if (options.inputSampleRate !in 8_000..48_000 || options.outputSampleRate !in 8_000..48_000) {
        promise.reject("ERR_VOICE_AUDIO_RATE", "Unsupported audio sample rate", null)
        return@AsyncFunction
      }
      T3VoiceAudioService.start(context, options.inputSampleRate, options.outputSampleRate) { error ->
        if (error == null) promise.resolve(null)
        else promise.reject("ERR_VOICE_AUDIO_START", error.message ?: "Audio could not start", error)
      }
    }

    AsyncFunction("startCallService") { promise: Promise ->
      val context = appContext.reactContext as? ReactContext
      if (context == null) {
        promise.reject("ERR_VOICE_SERVICE", "React context is unavailable", null)
      } else {
        T3VoiceAudioService.start(context, 16_000, 24_000, livekit = true) { error ->
          if (error == null) {
            try {
              callRunning = true
              callGeneration += 1
              // RN pauses JS timers on host pause unless a headless task is active.
              // Keep LiveKit's signaling heartbeat alive for this call only.
              HeadlessJsTaskContext.getInstance(context).startTask(
                HeadlessJsTaskConfig("T3VoiceCall", Arguments.createMap().apply {
                  putInt("generation", callGeneration)
                }, 0, true),
              )
              promise.resolve(null)
            } catch (failure: Throwable) {
              finishBackgroundCall()
              T3VoiceAudioService.stop(context)
              promise.reject("ERR_VOICE_SERVICE", failure.message, failure)
            }
          } else promise.reject("ERR_VOICE_SERVICE", error.message, error)
        }
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("waitForCallEnd") { generation: Int, promise: Promise ->
      if (callRunning && generation == callGeneration) callWaiters.add(promise)
      else promise.resolve(null)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopCallService") {
      appContext.reactContext?.let { T3VoiceAudioService.stop(it) }
      finishBackgroundCall()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setCallMuted") { muted: Boolean -> T3VoiceAudioService.setCallMuted(muted) }
      .runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      appContext.reactContext?.let { T3VoiceAudioService.stop(it) }
    }
    AsyncFunction("setMuted") { muted: Boolean -> VoiceAudioEngine.setMuted(muted) }
    AsyncFunction("setAudioRoute") { route: String -> VoiceAudioEngine.setAudioRoute(route) }
    AsyncFunction("enqueueAudio") { chunk: AudioChunk ->
      VoiceAudioEngine.enqueueAudio(chunk.pcmBase64, chunk.responseId)
    }
    AsyncFunction("finishResponse") { responseId: String -> VoiceAudioEngine.finishResponse(responseId) }
    AsyncFunction("clearPlayback") { VoiceAudioEngine.clearPlayback() }
  }
}
