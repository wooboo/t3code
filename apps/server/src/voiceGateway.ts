import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  startVoiceGateway,
  type VoiceGatewayHandle,
} from "../../../packages/voice-gateway/src/host.mjs";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";
import * as SessionStore from "./auth/SessionStore.ts";
import * as ServerConfig from "./config.ts";

class VoiceGatewayStartError extends Schema.TaggedError<VoiceGatewayStartError>()(
  "VoiceGatewayStartError",
  { cause: Schema.Defect() },
) {}

export class VoiceGateway extends Context.Service<VoiceGateway, VoiceGatewayHandle | undefined>()(
  "t3/voiceGateway",
) {}

export const voiceGatewayLayer = Layer.effect(
  VoiceGateway,
  Effect.gen(function* () {
    // Ordinary environments do not load speech modules or start background workers.
    if (process.env.T3_VOICE_ENABLED !== "1") return undefined;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const server = yield* HttpServer.HttpServer;
    const sessions = yield* SessionStore.SessionStore;
    const address = server.address;
    if (address._tag === "UnixPathAddress") return undefined;
    const source = import.meta.url.endsWith(".ts");
    const workerUrl = new URL(
      source ? "../../../packages/voice-gateway/src/worker.mjs" : "./voice-bundle/worker.mjs",
      import.meta.url,
    );
    const templateDirectory = yield* path.fromFileUrl(
      new URL(
        source ? "../../../packages/voice-gateway/config/frontend-agent/" : "./voice-config/",
        import.meta.url,
      ),
    );
    let credential: SessionStore.IssuedSession | undefined;
    let pending: Promise<string> | undefined;
    const subject = `voice-gateway:${config.port}`;
    const token = Effect.gen(function* () {
      const now = yield* DateTime.now;
      if (
        !credential ||
        DateTime.toEpochMillis(credential.expiresAt) - DateTime.toEpochMillis(now) < 300_000
      ) {
        credential = yield* sessions.issue({
          subject,
          ttl: Duration.hours(1),
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          replaceActiveForSubjectAndMethod: true,
          client: { label: "T3 voice gateway", deviceType: "bot" },
        });
      }
      return credential.token;
    });
    const runtime = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtime);
    yield* Effect.addFinalizer(() =>
      credential ? sessions.revoke(credential.sessionId).pipe(Effect.ignore) : Effect.void,
    );
    return yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startVoiceGateway({
            workerUrl,
            templateDirectory,
            dataDirectory: path.join(config.baseDir, "voice"),
            origin: `http://127.0.0.1:${address.port}`,
            configFile: process.env.VOICE_CONFIG_FILE,
            port: Number(process.env.T3_VOICE_PORT || 0),
            publicOrigin: process.env.T3_VOICE_PUBLIC_ORIGIN,
            getToken: () =>
              (pending ||= runPromise(token).finally(() => {
                pending = undefined;
              })),
          }),
        catch: (cause) => new VoiceGatewayStartError({ cause }),
      }),
      (gateway) => Effect.promise(() => gateway.close()),
    );
  }),
);
