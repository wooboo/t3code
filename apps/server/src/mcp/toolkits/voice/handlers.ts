import { CallUserInput, CallUserResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { VoiceGateway } from "../../../voiceGateway.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { VoiceCallToolError, VoiceToolkit } from "./tools.ts";

export const VoiceToolkitHandlersLive = VoiceToolkit.toLayer(
  Effect.gen(function* () {
    const gateway = yield* VoiceGateway;
    return VoiceToolkit.of({
      call_user: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext;
          if (!gateway || gateway.closed)
            return {
              status: "unavailable" as const,
              message: "Voice calling is not enabled in this environment. No call was placed.",
            };
          const url = new URL("/livekit/call-user", gateway.origin);
          url.searchParams.set("thread", scope.threadId);
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
    });
  }),
);
