# Local LiveKit voice pilot

Run `pnpm dlx node@24.13.1 scripts/voice-front/compare.mjs` on Minion.
The launcher retains its historical filename and isolated `.t3/voice-compare`
state directory. It starts T3, LiveKit and local Parakeet STT; it no longer starts
the old speech-to-speech transport. T3 owns coding threads, provider sessions,
permissions and settlement state. The voice bridge uses T3’s authenticated protocol-v2 RPC executor.

## Configuration and access

Pair with the pilot's HTTPS origin, then open Settings → Voice. Select a T3
conversation provider and model, or Custom API with a model ID, API URL, optional
key and API type (Responses or Chat Completions). Keys remain on the server.
An empty API URL uses OpenCode Go with its existing server credentials; it
requires Responses. Custom endpoint failures do not fall back to this default.
Conversation inference and the thread's coding agent are configured separately.
Codex conversation replies stream spoken text through its app-server; tool requests
are released after the complete response is validated. Other native providers
currently return a complete reply. Streaming starts synthesis earlier for longer
replies, but does not remove the wait for the model's first token.

Settings also controls STT, TTS, the fixed Voice ID, global instructions,
end-of-speech silence and interruptions. Use Save and apply; service changes automatically restart the environment. This ends active calls and briefly disconnects the isolated
T3 environment. Provider selection and instructions apply to the next call after saving.
Project and thread instructions remain beside the conversation.

Start a call from the microphone beside Send. In a new web thread, this creates
the thread and connects without a typed message. Select Current checkout first;
voice-only creation does not prepare a new worktree. Open its
Voice panel from the right panel's Add panel surface menu. Hiding the panel
keeps the call active; hang up to disconnect. Leaving the thread ends the call,
but does not cancel already delegated coding work. Transcripts are stored by
the voice bridge. Each LiveKit call starts fresh model conversation context.
No model rewrites STT transcripts. Replies follow the user's language unless
an explicit instruction requests another language.

LAN microphone access needs HTTPS. Set `VOICE_COMPARE_PUBLIC_ORIGIN` to the
paired origin and route the whole origin, including `/voice/`, to this T3/Vite
instance. LiveKit media uses UDP 18882 and TCP 18881; remote devices must reach
Minion at the advertised address. Browser cookies and mobile bearer credentials
protect session creation. The private model bridge has separate authentication.
Do not point the launcher at live T3 userdata or publish this development ingress.

## Voice across environments

The Voice host can operate threads on another T3 server without installing speech
services there. In the Voice host's Settings → Voice → Execution environments,
paste a fresh pairing URL issued by the execution server. This creates a separate
server-owned T3 session; pairing the phone alone does not grant the Voice host access.
Credentials stay on the Voice host and survive its restart. Re-pair when they expire
or are revoked. Disconnect closes voice calls to that target but leaves coding work
running on the execution server.

In the Voice web client, add the execution server through Connections and open its
thread normally. The microphone sends audio to the Voice host and identifies the
execution environment alongside the thread. On mobile, pair both environments,
then select the speech-enabled environment under Settings → Voice → Voice server.
Open any paired execution environment's thread to use that Voice host. Selecting
“Use each thread’s environment” restores the original per-environment behavior.

The target owns its coding model, runtime permissions and approvals. Voice uses
its own conversation model and the target thread's recent history. It never reads
remote workspace paths from its own filesystem. This supports direct T3 HTTP/HTTPS
bearer connections, including LAN or HTTPS tunnels; relay/DPoP is not supported.
The Voice host must reach the target, and clients must reach the Voice host's media
ports. Interrupted requests are not automatically redispatched. Check the target
thread after a lost acknowledgement before asking to repeat a task.

## Local inference and ElevenLabs

The default STT is local Parakeet. A custom transcription server must expose a
compatible transcription API. Direct conversation APIs can target local servers.
A loopback URL does not itself imply local inference: port 18092 is an ElevenLabs
proxy and calls the cloud. It reads `~/.config/elevenlabs/api-key`; select a fixed
Voice ID in Settings to retain the same voice between responses.

For Breeze TTS 2, start the speech server in an isolated Python environment with
`mlx-audio==0.5.4` installed:

```sh
/path/to/mlx-env/bin/python packages/voice-gateway/prototype/mlx-tts-server.py
```

Select Breeze TTS 2 in Settings and use Save and apply. It uses port 18091, the neutral
voice and 24 kHz PCM. The model downloads on first use, then runs locally. Polish
remains experimental. The separately started TTS server survives launcher restarts.

## Native clients

Voice clients and execution environments require protocol v2. Rebuild web and
mobile together when upgrading from protocol v1.

Web, desktop and mobile use LiveKit. Mobile requires a native build containing
LiveKit/WebRTC; Expo Go cannot load it. Pair using the same HTTPS T3 origin and
open Settings → Voice or a persisted thread's microphone control. Relay/DPoP
voice connections remain unsupported.

For an Android build that coexists with production, run
`APP_VARIANT=development expo prebuild --platform android --no-install` in
`apps/mobile`, then from the generated Android directory:

```sh
APP_VARIANT=development ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Set `JAVA_HOME` and `ANDROID_HOME` for the local toolchain. The generated signing
configuration is for testing, not publication. Grant microphone permission while
the app is visible. Physical microphone, Bluetooth, screen-off operation and LAN
latency require device testing; compilation alone does not verify those flows.

The launcher tracks its child processes in `.t3/voice-compare/processes.json`.
Stop only the launcher PID you own; never kill processes by a path or name pattern.

## Android callbacks

The thread's coding agent can invoke `call_user` when the user has authorized a
callback. During that thread's active call it hands the reason to the voice
agent. Otherwise it sends an invitation to the last Android phone registered
with this personal voice host. A push acknowledgement is not an answered call.
Invitations expire after 45 seconds and are not automatically retried.

Incoming calls support Firebase Cloud Messaging or UnifiedPush on Android.
For FCM, set `T3CODE_VOICE_FCM_CREDENTIALS` to an absolute path to a Firebase
service-account JSON file outside the repository. Enable the FCM HTTP v1 API
and grant that account permission to send messages in its project. Build the
Android app with `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` pointing to the matching
`google-services.json`. The server advertises the project ID, and the native
client refuses registration against a different Firebase project. FCM uses
high-priority data messages with a 45-second TTL; ntfy is not required.

Without the FCM credential setting, the host continues to use UnifiedPush.
Install a distributor such as ntfy, select `https://ntfy.sh` or your own server,
and allow the distributor to run in the background. For self-hosting, see the
[portable ntfy deployment](../../packages/voice-gateway/deploy/ntfy/README.md).
Preserve the gateway's private `push-vapid.json` when moving a UnifiedPush host.

Enable incoming calls in T3's Voice settings for the chosen environment and
grant notification permission. After switching providers, reopen T3 or renew
registration there. Existing opted-in devices migrate when they register with
the new provider; disabled callbacks remain disabled. Invitations contain only
routing identifiers and expiry, not conversation content. Token and endpoint
changes sync while connected or on the next foreground refresh. Android controls
whether calls appear full-screen or as a notification.

Answering creates the media session in the invitation's original environment
and thread. The agent waits for speech; after three seconds of silence with the
microphone connected, it asks “Jest tam kto?” once. Declining does not create a
media session. Receiving callbacks currently requires Android, a direct HTTPS
bearer connection, and a voice gateway on the coding agent's environment; iOS
PushKit/CallKit and forwarding callback tools from another execution server are
not implemented. Existing calls and transcripts still work on other supported
clients.
