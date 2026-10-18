import * as McpToolAccess from "../../McpToolAccess.ts";
import { CallUserInput, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import { VoiceGateway } from "../../../voiceGateway.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { VoiceToolkitHandlersLive } from "./handlers.ts";
import { VoiceToolkit } from "./tools.ts";

const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(CallUserInput));

afterEach(() => vi.unstubAllGlobals());
const scope = {
  environmentId: EnvironmentId.make("environment-a"),
  requestNamespace: "provider-session",
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread-a"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  capabilities: new Set<never>(),
  issuedAt: 0,
};
function call(enabled: boolean) {
  return Effect.gen(function* () {
    const toolkit = yield* VoiceToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(VoiceToolkitHandlersLive).pipe(
          Layer.provide(
            Layer.succeed(
              VoiceGateway,
              enabled
                ? {
                    origin: "http://127.0.0.1:9999",
                    closed: false,
                    close: async () => {},
                  }
                : undefined,
            ),
          ),
        ),
      ),
    );
    return yield* toolkit
      .handle("call_user", { reason: "Wyniki gotowe", context: "Testy przeszły" })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunks) => chunks.at(-1)!.result),
        Effect.provideService(McpInvocationContext, scope),
      );
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
}
it.effect("binds call_user to its authenticated thread and forwards the handoff", () =>
  Effect.gen(function* () {
    const fetcher = vi.fn(async () =>
      Response.json({ status: "delivered_to_voice_agent", callId: "call-a" }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(yield* call(true)).toEqual({ status: "delivered_to_voice_agent", callId: "call-a" });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.searchParams.get("thread")).toBe("thread-a");
    expect(url.searchParams.get("environmentId")).toBe("environment-a");
    expect(yield* decodeInput(new TextDecoder().decode(init.body as Uint8Array))).toEqual({
      reason: "Wyniki gotowe",
      context: "Testy przeszły",
    });
  }),
);
it.effect("does not claim to ring when voice is disabled", () =>
  Effect.gen(function* () {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(yield* call(false)).toMatchObject({ status: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  }),
);
it.effect("rejects a malformed acknowledgement instead of reporting success", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "answered" })),
    );
    expect((yield* Effect.exit(call(true)))._tag).toBe("Failure");
  }),
);
