import { TurnMeter, summarize } from "./metrics.mjs";

const $ = (id) => document.getElementById(id);
const thread = new URL(location.href).searchParams.get("thread");
const runs = [];
let configuration;
let call = null;
let generation = 0;
const variant = () => document.querySelector('input[name="variant"]:checked').value;
const endpoint = (path) => new URL(path, new URL("../", location.href));
const now = () => performance.now();
const worklet = `class CompareAudio extends AudioWorkletProcessor {
  constructor(options) { super(); this.playback = options.processorOptions.playback; this.samples = []; }
  process(inputs, outputs) {
    const channel = inputs[0]?.[0] || (this.playback ? outputs[0]?.[0] : null);
    if (channel) {
      if (this.playback) for (const output of outputs[0] || []) output.set(channel);
      for (const sample of channel) this.samples.push(sample);
      if (this.samples.length >= sampleRate * .04) {
        const samples = new Float32Array(this.samples);
        let energy = 0; for (const sample of samples) energy += sample * sample;
        this.port.postMessage({ level: Math.sqrt(energy / samples.length), samples: this.playback ? null : samples });
        this.samples = [];
      }
    }
    return true;
  }
} registerProcessor('compare-audio', CompareAudio);`;

async function request(path, options = {}) {
  const response = await fetch(endpoint(path), {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Error(
      body.error || `HTTP ${response.status}. Sparuj tę przeglądarkę z T3 i sprawdź konfigurację.`,
    );
  }
  return response.status === 204 ? null : response.json();
}
function render() {
  const selected = variant();
  $("start").textContent = "Rozpocznij rozmowę";
  $("start").disabled =
    Boolean(call) || !configuration || (selected === "livekit" && !configuration.ready);
  $("stop").disabled = !call;
  $("mute").disabled = !call?.ready;
  $("variants").disabled = Boolean(call);
  $("scenario").disabled = Boolean(call);
  $("export").disabled = runs.length === 0;
  $("clear").disabled = Boolean(call) || runs.length === 0;
  $("summary").replaceChildren();
  for (const mode of ["livekit"]) {
    const summary = summarize(runs, mode);
    const tr = document.createElement("tr");
    const ms = (value) => (value === null ? "—" : `${Math.round(value)} ms`);
    for (const text of [
      "LiveKit",
      summary.samples,
      ms(summary.p50),
      ms(summary.p95),
      summary.unanswered,
      summary.failedRuns,
    ]) {
      const td = document.createElement("td");
      td.textContent = String(text);
      tr.append(td);
    }
    $("summary").append(tr);
  }
}
function record(run, event) {
  if (run.events.length >= 1000) return;
  run.events.push({ ...event, atMs: Math.round(now() - run.clockStart) });
  $("events").textContent = JSON.stringify(run.events.slice(-35), null, 2);
  render();
}
function receive(current, event) {
  if (call !== current) return;
  if (event.type === "call.ended") {
    stop();
    return;
  }
  if (event.type === "voice.state") {
    $("status").textContent =
      { listening: "Słucham", thinking: "Myślę…", speaking: "Odpowiadam" }[event.state] ||
      event.state;
  }
  if (event.type === "transcript.final") {
    const id = String(event.id || `${event.role}:${event.responseId || event.turnId}`);
    let p = current.transcripts.get(id);
    if (!p) {
      p = document.createElement("p");
      current.transcripts.set(id, p);
      $("transcript").append(p);
    }
    p.textContent = `${event.role === "user" ? "Ty" : "Głos"}: ${event.content}`;
  }
  if (
    ["transcript.final", "voice.state", "sdk.metrics", "task.state", "error"].includes(event.type)
  )
    record(current.run, event);
  if (event.type === "error" || event.type === "voice.deactivated")
    fail(current, event.message || "Serwer głosu jest zajęty.");
}
function fail(current, message) {
  if (call !== current) return;
  current.run.error = message;
  $("error").textContent = message;
  stop();
}
function stop() {
  const current = call;
  if (!current) return;
  generation++;
  call = null;
  clearTimeout(current.timeout);
  current.meter.finish();
  current.run.finishedAt = new Date().toISOString();
  current.abort.abort();
  current.stream?.getTracks().forEach((track) => track.stop());
  if (current.socket) {
    current.socket.onclose = null;
    current.socket.onerror = null;
    current.socket.close();
  }
  for (const [track, playback] of current.playbacks || []) {
    playback.source.disconnect();
    track.detach(playback.element);
    playback.element.pause();
    playback.element.srcObject = null;
    playback.element.remove();
  }
  if (current.room) void current.room.disconnect();
  for (const context of current.contexts) void context.close();
  if (current.connectionId)
    void request(`prototype/session/${current.connectionId}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
  $("status").textContent = "Rozmowa zakończona. Zlecone zadania sprawdzisz w T3.";
  $("mute").textContent = "Wycisz mikrofon";
  render();
}
async function audioNode(current, context, playback, callback) {
  const url = URL.createObjectURL(new Blob([worklet], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  if (call !== current) throw Error("Rozmowa zakończona");
  const node = new AudioWorkletNode(context, "compare-audio", { processorOptions: { playback } });
  node.port.onmessage = ({ data }) => {
    if (call === current) callback(data);
  };
  node.connect(context.destination);
  return node;
}
async function capture(current, rate, send) {
  const context = new AudioContext({ sampleRate: rate });
  current.contexts.add(context);
  const node = await audioNode(current, context, false, ({ level, samples }) => {
    current.meter.input(current.muted || current.suspended ? 0 : level, now());
    if (!current.muted && !current.suspended) send?.(samples);
  });
  context.createMediaStreamSource(current.stream).connect(node);
  await context.resume();
}
function ready(current) {
  if (call !== current) return;
  current.ready = true;
  clearTimeout(current.timeout);
  current.run.connectMs = Math.round(now() - current.run.clockStart);
  record(current.run, { type: "connected", connectMs: current.run.connectMs });
  $("status").textContent = "Słucham";
  render();
}
function encode(samples) {
  const bytes = new Uint8Array(samples.length * 2),
    view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => {
    const x = Math.max(-1, Math.min(1, sample));
    view.setInt16(i * 2, x * (x < 0 ? 32768 : 32767), true);
  });
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
async function livekit(current, output, sink) {
  const connection = await request("prototype/session", {
    method: "POST",
    body: JSON.stringify({ thread }),
    signal: current.abort.signal,
  });
  current.connectionId = connection.id;
  if (call !== current) {
    await request(`prototype/session/${connection.id}`, { method: "DELETE" });
    return;
  }
  if (location.protocol === "https:" && new URL(connection.url).protocol !== "wss:")
    throw Error("Ta strona HTTPS wymaga LIVEKIT_PUBLIC_URL z wss:// i osiągalnego serwera WebRTC.");
  const { DisconnectReason, Room, RoomEvent, Track } = window.LivekitClient;
  const room = new Room();
  current.room = room;
  current.playbacks = new Map();
  const detach = (track) => {
    const playback = current.playbacks.get(track);
    if (!playback) return;
    playback.source.disconnect();
    track.detach(playback.element);
    playback.element.pause();
    playback.element.srcObject = null;
    playback.element.remove();
    current.playbacks.delete(track);
  };
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio || call !== current) return;
    // Chromium needs a playing media element to pull remote WebRTC audio.
    // Keep it muted: the common WebAudio sink owns playback and measurements.
    const element = document.createElement("audio");
    element.muted = true;
    element.volume = 0;
    element.hidden = true;
    document.body.append(element);
    track.attach(element);
    element.muted = true;
    const source = output.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    source.connect(sink);
    current.playbacks.set(track, { element, source });
    void element
      .play()
      .catch(() =>
        fail(
          current,
          "Przeglądarka zablokowała odtwarzanie audio. Zezwól na dźwięk i rozpocznij rozmowę ponownie.",
        ),
      );
  });
  room.on(RoomEvent.TrackUnsubscribed, detach);
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (participant?.identity !== `voice-agent-${connection.id}` || topic !== "t3.voice.prototype")
      return;
    try {
      receive(current, JSON.parse(new TextDecoder().decode(payload)));
    } catch {
      fail(current, "Nieprawidłowe zdarzenie LiveKit.");
    }
  });
  room.on(RoomEvent.Reconnecting, () => {
    if (call === current) {
      $("status").textContent = "Wznawianie połączenia…";
      record(current.run, { type: "reconnecting" });
    }
  });
  room.on(RoomEvent.Reconnected, () => {
    if (call === current) {
      $("status").textContent = "Połączenie wznowione";
      record(current.run, { type: "reconnected" });
    }
  });
  room.on(RoomEvent.Disconnected, (reason) => {
    if (call !== current) return;
    if (reason === DisconnectReason.ROOM_DELETED) stop();
    else fail(current, "LiveKit rozłączył rozmowę.");
  });
  await room.connect(connection.url, connection.token);
  if (call !== current) {
    await room.disconnect();
    return;
  }
  await room.localParticipant.publishTrack(current.stream.getAudioTracks()[0], {
    source: Track.Source.Microphone,
  });
  await capture(current, 24000);
  ready(current);
}
async function start() {
  if (call || !configuration) return;
  if (runs.length >= 100) {
    $("error").textContent = "Pobierz i wyczyść wyniki przed kolejnymi próbami.";
    return;
  }
  const run = {
    variant: variant(),
    scenario: $("scenario").value,
    thread,
    startedAt: new Date().toISOString(),
    clockStart: now(),
    configuration,
    events: [],
  };
  runs.push(run);
  const current = {
    run,
    generation: ++generation,
    contexts: new Set(),
    abort: new AbortController(),
    ready: false,
    muted: false,
    suspended: false,
    transcripts: new Map(),
  };
  call = current;
  current.meter = new TurnMeter((event) => record(run, event));
  current.timeout = setTimeout(
    () => fail(current, "Przekroczono 45 sekund oczekiwania na połączenie."),
    45000,
  );
  $("error").textContent = "";
  $("status").textContent = "Łączenie…";
  $("transcript").replaceChildren();
  render();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error("Mikrofon wymaga HTTPS albo localhost.");
    const output = new AudioContext({ sampleRate: 24000 });
    current.contexts.add(output);
    await output.resume();
    current.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (call !== current) {
      current.stream.getTracks().forEach((track) => track.stop());
      return;
    }
    // Refresh the fingerprint before every run; never claim models stayed the same after settings edits.
    run.configuration = await request(`prototype/config?thread=${encodeURIComponent(thread)}`, {
      signal: current.abort.signal,
    });
    const sink = await audioNode(current, output, true, ({ level }) =>
      current.meter.output(level, now()),
    );
    await livekit(current, output, sink);
  } catch (error) {
    fail(
      current,
      error.name === "NotAllowedError"
        ? "Brak zgody na mikrofon. Zezwól na dostęp w przeglądarce i ustawieniach systemu, a potem spróbuj ponownie."
        : error.message,
    );
  }
}
$("start").onclick = () => void start();
$("stop").onclick = stop;
$("mute").onclick = () => {
  if (!call) return;
  call.muted = !call.muted;
  call.stream?.getAudioTracks().forEach((track) => {
    track.enabled = !call.muted && !call.suspended;
  });
  call.setMuted?.(call.muted);
  $("mute").textContent = call.muted ? "Włącz mikrofon" : "Wycisz mikrofon";
  record(call.run, { type: call.muted ? "muted" : "unmuted" });
};
$("variants").onchange = render;
$("clear").onclick = () => {
  if (!call) {
    runs.length = 0;
    $("events").textContent = "Brak zdarzeń.";
    render();
  }
};
$("export").onclick = () => {
  const report = {
    prototype: "t3-livekit-ab-v1",
    exportedAt: new Date().toISOString(),
    measurement:
      "Client-clock RMS proxy: input >0.025 for 120ms; output >0.008 after 200ms input silence; 40ms frames. Not hardware latency or TTFT.",
    runs,
    summary: { gateway: summarize(runs, "gateway"), livekit: summarize(runs, "livekit") },
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "t3-voice-comparison.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener("pagehide", stop);
if (thread) {
  $("thread").textContent = `Wątek T3: ${thread}`;
  request(`prototype/config?thread=${encodeURIComponent(thread)}`)
    .then((value) => {
      configuration = value;
      $("config").textContent = JSON.stringify(value, null, 2);
      $("status").textContent = "Gotowe do porównania";
      $("configuration-note").textContent = value.ready
        ? "Porównanie całych ścieżek. Sprawdź poniżej zgodność modeli i ustawień."
        : `A jest dostępne. B wymaga konfiguracji: ${value.missing.join(", ")}.`;
      render();
    })
    .catch((error) => {
      $("error").textContent = error.message;
      $("status").textContent = "Konfiguracja niedostępna";
    });
} else $("error").textContent = "Otwórz porównanie z panelu głosu w wybranym wątku T3.";
render();
