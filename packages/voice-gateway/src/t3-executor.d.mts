export declare class T3VoiceExecutor {
  constructor(options: {
    origin: string;
    token: string | (() => string | Promise<string>);
    fetchImpl?: typeof fetch;
    wait?: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
    now?: () => number;
    completionTimeoutMs?: number;
  });
  dispatchCommand(command: unknown, signal?: AbortSignal): Promise<{ sequence: number }>;
  runSelectedSession(
    context: { ownerId: string; agentSessionId: string },
    input: { objective?: string; finalAsr?: string },
    options?: { ownerId?: string; signal?: AbortSignal },
  ): Promise<{ content: string; runId?: string }>;
}
