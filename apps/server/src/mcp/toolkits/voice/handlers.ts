import * as McpToolAccess from "../../McpToolAccess.ts";
import { CallUserInput, CallUserResult, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { VoiceGateway } from "../../../voiceGateway.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { VoiceCallToolError, VoiceToolkit } from "./tools.ts";

export const VoiceToolkitHandlersLive = McpToolAccess.toLayer(
  VoiceToolkit,
  Effect.gen(function* () {
    const gateway = yield* VoiceGateway;
    return {
      call_user: McpToolAccess.readsAsCaller((input: CallUserInput) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext;
          if (scope.client?.access === "read-only")
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Voice calling requires write access.",
            });
          if (!scope.thread)
            return { status: "unavailable" as const, message: "Voice calling requires a thread." };
          if (!gateway || gateway.closed)
            return {
              status: "unavailable" as const,
              message: "Voice calling is not enabled in this environment. No call was placed.",
            };
          const url = new URL("/livekit/call-user", gateway.origin);
          url.searchParams.set("thread", scope.thread.threadId);
          url.searchParams.set("environmentId", scope.environmentId);
          return yield* HttpClientRequest.post(url.toString()).pipe(
            HttpClientRequest.schemaBodyJson(CallUserInput)(input),
            Effect.flatMap(HttpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(CallUserResult)),
            Effect.timeout("15 seconds"),
            Effect.mapError(
              () =>
                new VoiceCallToolError({
                  message:
                    "Could not confirm delivery to the voice agent. Check the thread before retrying.",
                }),
            ),
            Effect.provide(FetchHttpClient.layer),
          );
        }),
      ),
    };
  }),
);
