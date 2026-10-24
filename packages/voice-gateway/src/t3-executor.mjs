import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import { dispatchT3Command } from "./t3-rpc.mjs";

/** Bridge voice work to protocol-v2 threads and their run ownership. */
export class T3VoiceExecutor {
  constructor({
    origin,
    token,
    fetchImpl = fetch,
    wait = NodeTimersPromises.setTimeout,
    now = Date.now,
    completionTimeoutMs = 10 * 60_000,
  }) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("T3 requires an HTTP or HTTPS endpoint");
    this.origin = url.origin;
    this.token = token;
    this.fetch = fetchImpl;
    this.wait = wait;
    this.now = now;
    this.completionTimeoutMs = completionTimeoutMs;
    this.admissions = new Map();
    this.enabled = true;
    this.protocol = "t3";
    this.label = "T3 Code";
  }
  async request(path, body, signal, timeoutMs = 15000) {
    const response = await this.fetch(this.origin + path, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
      headers: {
        Authorization: `Bearer ${typeof this.token === "function" ? await this.token() : this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(path.startsWith("/api/orchestration/") ? { "x-t3-orchestration-protocol": "2" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`T3 ${path}: HTTP ${response.status}`);
    return response.json();
  }
  dispatchCommand(command, signal) {
    return dispatchT3Command({ origin: this.origin, token: this.token, command, signal });
  }
  async threadProjection(id, signal) {
    const snapshot = await this.request(
      `/api/orchestration/threads/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
    return snapshot.projection;
  }
  async listNativeSessions() {
    const shell = await this.request("/api/orchestration/shell");
    return shell.threads
      .filter((t) => !t.deletedAt && !t.archivedAt)
      .map((t) => ({
        sessionId: t.id,
        title: t.title,
        cwd: t.worktreePath || shell.projects.find((p) => p.id === t.projectId)?.workspaceRoot,
        updatedAt: t.updatedAt,
      }));
  }
  async *streamVoiceResponse(body, signal) {
    const response = await this.fetch(this.origin + "/api/voice/stream", {
      method: "POST",
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]),
      headers: {
        Authorization: `Bearer ${typeof this.token === "function" ? await this.token() : this.token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) throw Error(`T3 voice stream: HTTP ${response.status}`);
    let buffer = "";
    let data = [];
    let size = 0;
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      if (buffer.length + size > 1_000_000) throw Error("Voice stream event is too large");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) {
            const event = JSON.parse(data.join("\n"));
            data = [];
            size = 0;
            if (event.type === "error") throw Error("Voice inference failed");
            yield event;
            if (event.type === "completed") return;
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
          size += line.length;
        }
      }
    }
    throw Error("Voice stream ended before completion");
  }
  async health() {
    try {
      await this.request("/api/orchestration/shell");
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
  status() {
    return { status: "ready", protocol: "t3", label: this.label };
  }
  describe() {
    return { enabled: true, protocol: "t3", label: this.label, capabilities: { backendUi: true } };
  }
  uiUrl() {
    return Promise.resolve(this.origin);
  }
  canRecoverDelegatedWork() {
    return false;
  }
  respondPermission() {
    throw new Error("Zatwierdź uprawnienia w T3 Code");
  }
  runCoordinator() {
    throw new Error("Wybierz wątek T3 Code przed zleceniem zadania");
  }
  close() {}
  async runSelectedSession(context, input, { ownerId, signal } = {}) {
    if (context.ownerId !== ownerId) throw new Error("Kontekst należy do innego użytkownika");
    if (input.inputParts?.length) throw new Error("Załączniki dodaj bezpośrednio w T3 Code");
    const id = context.agentSessionId;
    // Serialize command admission, not the lifetime of the agent's work.
    const previousAdmission = this.admissions.get(id);
    let release;
    const admission = new Promise((resolve) => {
      release = resolve;
    });
    this.admissions.set(id, admission);
    await previousAdmission;
    const releaseAdmission = () => {
      if (this.admissions.get(id) === admission) this.admissions.delete(id);
      release();
    };
    let ownedRunId = null;
    try {
      signal?.throwIfAborted();
      const beforeProjection = await this.threadProjection(id, signal);
      const before = beforeProjection.thread;
      if (before.deletedAt || before.archivedAt)
        throw new Error("Wątek jest usunięty lub zarchiwizowany");
      const messageId = NodeCrypto.randomUUID();
      await this.dispatchCommand(
        {
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "server",
          commandId: NodeCrypto.randomUUID(),
          threadId: id,
          messageId,
          text: this.prepareObjective
            ? await this.prepareObjective(ownerId, id, input.objective || input.finalAsr || "")
            : input.objective || input.finalAsr || "",
          attachments: [],
          modelSelection: before.modelSelection,
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
        },
        signal,
      );
      releaseAdmission();
      const deadline = this.now() + this.completionTimeoutMs;
      while (this.now() < deadline) {
        const projection = await this.threadProjection(id, signal);
        if (projection.thread.deletedAt || projection.thread.archivedAt)
          throw new Error("Wątek jest usunięty lub zarchiwizowany");
        const index = projection.messages.findIndex((m) => m.id === messageId);
        if (index >= 0) {
          // Steered messages belong to an existing run; queued messages receive their own.
          // Later user messages never transfer observation or cancellation ownership.
          const message = projection.messages[index];
          const run =
            projection.runs.find((run) => run.userMessageId === messageId) ??
            projection.runs.find((run) => run.id === message.runId);
          if (run) {
            if (run.userMessageId === messageId) ownedRunId = run.id;
            if (["failed", "interrupted", "cancelled"].includes(run.status))
              throw new Error(`T3: ${run.status}`);
            if (run.status === "completed") {
              const results = projection.messages.filter(
                (message) =>
                  message.runId === run.id &&
                  message.role === "assistant" &&
                  !message.streaming &&
                  message.text,
              );
              if (results.length)
                return {
                  content: results.map((message) => message.text).join("\n\n"),
                  runId: run.id,
                };
              return { content: "Zadanie zakończone. Wynik sprawdzisz w T3 Code.", runId: run.id };
            }
          }
        }
        await this.wait(350, undefined, { signal });
      }
      throw new Error("Przekroczono czas oczekiwania; sprawdź stan zadania w T3 Code");
    } catch (error) {
      // Never send an unscoped interrupt: another T3 client may own the next turn.
      if (signal?.aborted && ownedRunId) {
        await this.dispatchCommand({
          type: "run.interrupt",
          commandId: NodeCrypto.randomUUID(),
          threadId: id,
          runId: ownedRunId,
        }).catch(() => {});
      }
      throw error;
    } finally {
      releaseAdmission();
    }
  }
}
