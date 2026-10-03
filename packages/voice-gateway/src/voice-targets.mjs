import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { T3VoiceExecutor } from "./t3-executor.mjs";

/** Server-owned T3 pairings; credentials never appear in the public target catalogue. */
export class VoiceTargets {
  constructor(file, local, fetchImpl = fetch) {
    this.file = file;
    this.local = local;
    this.fetch = fetchImpl;
    this.clients = new Map();
    this.entries = NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : [];
  }
  save() {
    NodeFS.mkdirSync(NodePath.dirname(this.file), { recursive: true });
    NodeFS.writeFileSync(this.file + ".tmp", JSON.stringify(this.entries), { mode: 0o600 });
    NodeFS.renameSync(this.file + ".tmp", this.file);
  }
  async localId() {
    return (this.localEnvironmentId ||= (
      await this.fetch(this.local.origin + "/.well-known/t3/environment").then((r) => r.json())
    ).environmentId);
  }
  list(ownerId) {
    return this.entries
      .filter((e) => e.ownerId === ownerId)
      .map(({ environmentId, label, origin, expiresAt }) => ({
        environmentId,
        label,
        origin,
        expiresAt,
      }));
  }
  async pair(ownerId, pairingUrl) {
    const url = new URL(pairingUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw Error("Enter an HTTP or HTTPS T3 pairing URL.");
    const credential =
      new URLSearchParams(url.hash.slice(1)).get("token") || url.searchParams.get("token");
    if (!credential) throw Error("The pairing URL must include a token.");
    const origin = url.origin;
    const descriptorResponse = await this.fetch(origin + "/.well-known/t3/environment", {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!descriptorResponse.ok) throw Error("The target is not a reachable T3 environment.");
    const descriptor = await descriptorResponse.json();
    if (typeof descriptor.environmentId !== "string")
      throw Error("Invalid T3 environment descriptor.");
    if (descriptor.orchestrationProtocolVersion !== 2)
      throw Error(
        "This voice client requires a protocol-v2 T3 server. Update the execution environment before pairing.",
      );
    if (descriptor.environmentId === (await this.localId()))
      throw Error("This is already the local voice environment.");
    const response = await this.fetch(origin + "/oauth/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: credential,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        client_label: "T3 Voice",
        client_device_type: "bot",
      }),
    });
    if (!response.ok)
      throw Error("Pairing failed. Generate a fresh link on the target environment.");
    const data = await response.json();
    if (data.token_type !== "Bearer" || !data.access_token)
      throw Error("This connection requires bearer authentication.");
    this.add(ownerId, {
      environmentId: descriptor.environmentId,
      label: descriptor.label || descriptor.environmentId,
      origin,
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    return this.list(ownerId);
  }
  add(ownerId, entry) {
    this.entries = this.entries.filter(
      (e) => e.ownerId !== ownerId || e.environmentId !== entry.environmentId,
    );
    this.entries.push({ ...entry, ownerId });
    this.clients.delete(`${ownerId}:${entry.environmentId}`);
    this.save();
  }
  remove(ownerId, environmentId) {
    this.entries = this.entries.filter(
      (e) => e.ownerId !== ownerId || e.environmentId !== environmentId,
    );
    this.clients.delete(`${ownerId}:${environmentId}`);
    this.save();
  }
  async resolve(ownerId, environmentId) {
    if (!environmentId || environmentId === (await this.localId())) return this.local;
    const entry = this.entries.find(
      (e) => e.ownerId === ownerId && e.environmentId === environmentId,
    );
    if (!entry) throw Error("Pair this execution environment in Voice settings first.");
    if (entry.expiresAt <= Date.now())
      throw Error("The execution environment pairing expired. Pair it again in Voice settings.");
    const key = `${ownerId}:${environmentId}`;
    if (!this.clients.has(key))
      this.clients.set(
        key,
        new T3VoiceExecutor({ origin: entry.origin, token: entry.token, fetchImpl: this.fetch }),
      );
    return this.clients.get(key);
  }
}
