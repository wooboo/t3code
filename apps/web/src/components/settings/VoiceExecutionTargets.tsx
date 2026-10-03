import { useEffect, useState } from "react";
import type { VoiceExecutionTarget } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function VoiceExecutionTargets() {
  const [targets, setTargets] = useState<VoiceExecutionTarget[]>([]);
  const [pairingUrl, setPairingUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = "/voice/execution-targets";
  useEffect(() => {
    const abort = new AbortController();
    void fetch(endpoint, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw Error("Could not load execution environments.");
        setTargets((await r.json()).targets);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => abort.abort();
  }, []);
  async function pair() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingUrl }),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error || "Pairing failed.");
      setTargets(result.targets);
      setPairingUrl("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) throw Error("Could not disconnect environment.");
      setTargets((current) => current.filter((t) => t.environmentId !== id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 border-t border-border/60 pt-5"
      aria-labelledby="voice-execution-heading"
    >
      <h3 id="voice-execution-heading" className="text-sm font-medium">
        Execution environments
      </h3>
      <p className="text-xs leading-5 text-muted-foreground">
        Voice runs here. Pair another T3 environment to talk to its threads using their existing
        coding agents. Open that environment through Connections, then start voice in a thread.
      </p>
      {targets.map((target) => (
        <div key={target.environmentId} className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm">{target.label}</p>
            <p className="truncate text-xs text-muted-foreground">{target.origin}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void remove(target.environmentId)}
          >
            Disconnect
          </Button>
        </div>
      ))}
      <Label htmlFor="voice-target-pairing">T3 pairing URL</Label>
      <Input
        id="voice-target-pairing"
        type="password"
        autoComplete="off"
        value={pairingUrl}
        disabled={busy}
        onChange={(e) => setPairingUrl(e.target.value)}
        placeholder="Paste a new pairing link from the execution environment"
      />
      <Button disabled={busy || !pairingUrl.trim()} onClick={() => void pair()}>
        Pair execution environment
      </Button>
      <p className="text-xs text-muted-foreground">
        Pairing applies immediately. Disconnect ends active voice calls to this environment; coding
        work remains on its server.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
