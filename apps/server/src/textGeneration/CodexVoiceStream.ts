import {
  TextGenerationError,
  type CodexSettings,
  type VoiceInferenceEvent,
  type VoiceInferenceInput,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as CodexClient from "effect-codex-app-server/client";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { buildVoiceResponsePrompt, CODEX_VOICE_ARGS } from "./VoiceTextGeneration.ts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import { createVoiceJsonStream } from "./VoiceJsonStream.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const decodeMcpServers = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));

const failure = (cause: unknown) =>
  new TextGenerationError({
    operation: "generateVoiceResponse",
    detail: "Codex voice stream failed.",
    cause,
  });

/** A private ephemeral thread, scoped to the HTTP stream, with no coding-thread side effects. */
export function streamCodexVoice(
  input: VoiceInferenceInput & { readonly cwd: string },
  config: CodexSettings,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  return Stream.callback<VoiceInferenceEvent, TextGenerationError>(
    (queue) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildVoiceResponsePrompt(input.prompt);
        const env = {
          ...environment,
          ...(config.homePath
            ? { CODEX_HOME: expandHomePath(config.homePath, yield* HostProcess.HomeDirectory) }
            : {}),
        };
        // app-server has no exec-only ignore flags. Override instructions below and
        // explicitly disable every inherited MCP server before starting a thread.
        const command = yield* resolveSpawnCommand(
          config.binaryPath || "codex",
          [
            "app-server",
            ...codexExecLaunchArgs(resolveCodexLaunchArgs(config.launchArgs, environment)),
            ...CODEX_VOICE_ARGS.filter(
              (arg) => arg !== "--ignore-user-config" && arg !== "--ignore-rules",
            ),
          ],
          { env },
        );
        const child = yield* spawner.spawn(
          ChildProcess.make(command.command, command.args, {
            cwd: input.cwd,
            env,
            shell: command.shell,
            forceKillAfter: "2 seconds",
          }),
        );
        const context = yield* Layer.build(CodexClient.layerChildProcess(child));
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(context),
        );
        const done = yield* Deferred.make<void, TextGenerationError>();
        let threadId = "";
        let itemId: string | undefined;
        let json = "";
        const ignoredItems = new Set<string>();
        const decoder = createVoiceJsonStream();
        const append = (text: string) =>
          Effect.try({
            try: () => {
              json += text;
              return decoder.push(text);
            },
            catch: failure,
          }).pipe(
            Effect.flatMap((delta) =>
              delta ? Queue.offer(queue, { type: "text.delta", delta }) : Effect.void,
            ),
          );
        const guard = <A>(effect: Effect.Effect<A, TextGenerationError>) =>
          effect.pipe(
            Effect.catch((error) => Deferred.fail(done, error)),
            Effect.asVoid,
          );
        yield* client.handleServerNotification("item/started", (params) =>
          Effect.sync(() => {
            if (params.item.type === "agentMessage" && params.item.phase === "commentary")
              ignoredItems.add(params.item.id);
          }),
        );
        yield* client.handleServerNotification("item/agentMessage/delta", (params) =>
          guard(
            Effect.gen(function* () {
              if (params.threadId !== threadId || ignoredItems.has(params.itemId)) return;
              if (itemId && itemId !== params.itemId)
                return yield* failure("Multiple spoken messages");
              itemId = params.itemId;
              yield* append(params.delta);
            }),
          ),
        );
        yield* client.handleServerNotification("item/completed", (params) =>
          guard(
            Effect.gen(function* () {
              if (
                params.threadId !== threadId ||
                params.item.type !== "agentMessage" ||
                params.item.phase === "commentary" ||
                ignoredItems.has(params.item.id)
              )
                return;
              if ((itemId && itemId !== params.item.id) || !params.item.text.startsWith(json))
                return yield* failure("Spoken text changed during generation");
              itemId = params.item.id;
              yield* append(params.item.text.slice(json.length));
            }),
          ),
        );
        yield* client.handleServerNotification("turn/completed", (params) =>
          guard(
            Effect.gen(function* () {
              if (params.threadId !== threadId) return;
              if (params.turn.status !== "completed")
                return yield* failure(params.turn.error ?? params.turn.status);
              const result = yield* Effect.try({ try: () => decoder.finish(), catch: failure });
              yield* Queue.offer(queue, { type: "completed", result });
              yield* Deferred.succeed(done, undefined);
            }),
          ),
        );
        yield* child.exitCode.pipe(
          Effect.flatMap((code) =>
            Deferred.fail(done, failure(`Codex exited before completing the voice turn (${code})`)),
          ),
          Effect.catch((cause) => Deferred.fail(done, failure(cause))),
          Effect.forkScoped,
        );
        yield* client.request("initialize", {
          clientInfo: { name: "t3-voice", title: "T3 Voice", version: "1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: null },
        });
        yield* client.notify("initialized", undefined);
        const settings = yield* client.request("config/read", { includeLayers: false });
        const mcpServers = yield* decodeMcpServers(settings.config.mcp_servers ?? {});
        const serviceTier = getCodexServiceTierOptionValue(input.modelSelection);
        const thread = yield* client.request("thread/start", {
          cwd: input.cwd,
          model: input.modelSelection.model,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions: prompt,
          developerInstructions: "",
          config: {
            mcp_servers: Object.fromEntries(
              Object.keys(mcpServers).map((name) => [name, { enabled: false }]),
            ),
            model_reasoning_effort:
              getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ?? "low",
          },
          ...(serviceTier ? { serviceTier } : {}),
        });
        threadId = thread.thread.id;
        yield* client.request("turn/start", {
          threadId,
          input: [
            { type: "text", text: "Respond to the supplied conversation.", text_elements: [] },
          ],
          outputSchema: yield* decodeJson(toJsonSchemaObject(outputSchema)),
        });
        yield* Deferred.await(done);
        yield* Queue.end(queue);
      }).pipe(
        Effect.scoped,
        Effect.timeout("90 seconds"),
        Effect.catch((cause) => Queue.fail(queue, failure(cause))),
        Effect.forkScoped,
      ),
    { bufferSize: 64 },
  );
}
