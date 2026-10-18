import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  TextGenerationError,
  type VoiceInferenceEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const fs = yield* FileSystem.FileSystem;
    return handlers
      .handle(
        "stream",
        Effect.fn("environment.voice.stream")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const instance = yield* instances.getInstance(args.payload.modelSelection.instanceId);
          if (!instance?.enabled || !instance.textGeneration.generateVoiceResponse)
            return yield* new TextGenerationError({
              operation: "generateVoiceResponse",
              detail: "Selected voice provider is unavailable.",
            });
          const generation = instance.textGeneration;
          const generate = instance.textGeneration.generateVoiceResponse;
          // Allocate inside the stream scope: HTTP headers must not close its workspace.
          return Stream.unwrap(
            Effect.gen(function* () {
              const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-inference-" });
              if (generation.streamVoiceResponse)
                return generation.streamVoiceResponse({ ...args.payload, cwd });
              return Stream.fromEffect(
                generate({ ...args.payload, cwd }).pipe(
                  Effect.timeout("90 seconds"),
                  Effect.map((result): VoiceInferenceEvent => ({ type: "completed", result })),
                ),
              );
            }),
          ).pipe(
            Stream.catch(() =>
              Stream.succeed<VoiceInferenceEvent>({
                type: "error",
                message: "Voice inference failed or timed out.",
              }),
            ),
          );
        }),
      )
      .handle(
        "catalogue",
        Effect.fn("environment.voice.catalogue")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshots = yield* providers.getProviders;
          const capabilities = yield* Effect.forEach(snapshots, (snapshot) =>
            Effect.gen(function* () {
              const instance = yield* instances.getInstance(snapshot.instanceId);
              const supported = Boolean(
                instance?.enabled &&
                instance.textGeneration.generateVoiceResponse &&
                snapshot.installed &&
                snapshot.status !== "disabled" &&
                snapshot.availability !== "unavailable",
              );
              return {
                instanceId: snapshot.instanceId,
                supported,
                streaming: supported && Boolean(instance?.textGeneration.streamVoiceResponse),
                ...(!supported
                  ? {
                      reason:
                        "Provider unavailable or no verified tool-free conversation mode. Coding-thread support does not imply voice support.",
                    }
                  : {}),
              };
            }),
          );
          return { providers: snapshots, capabilities };
        }),
      )
      .handle(
        "respond",
        Effect.fn("environment.voice.respond")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const instance = yield* instances.getInstance(args.payload.modelSelection.instanceId);
          const generate = instance?.enabled
            ? instance.textGeneration.generateVoiceResponse
            : undefined;
          if (!generate)
            return yield* new TextGenerationError({
              operation: "generateVoiceResponse",
              detail:
                "Selected provider is unavailable or has no verified tool-free conversational mode.",
            });
          // Never load workspace instructions implicitly or attach a voice turn to the coding thread.
          // The caller supplies the inspected context explicitly in the prompt.
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-inference-" }).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "generateVoiceResponse",
                  detail: "Could not create isolated voice workspace.",
                  cause,
                }),
            ),
          );
          const started = yield* Clock.currentTimeMillis;
          const result = yield* generate({ ...args.payload, cwd }).pipe(
            Effect.timeoutOrElse({
              duration: 90_000,
              orElse: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation: "generateVoiceResponse",
                    detail: "Voice inference timed out after 90 seconds.",
                  }),
                ),
            }),
          );
          return {
            ...result,
            elapsedMs: (yield* Clock.currentTimeMillis) - started,
            streaming: false as const,
          };
        }, Effect.scoped),
      );
  }),
);
