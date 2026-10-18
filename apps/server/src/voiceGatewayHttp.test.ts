import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { layerMemory as SqlitePersistenceMemory } from "./persistence/Sqlite.ts";
import { voiceGatewayRouteLayer } from "./voiceGatewayHttp.ts";

const dependencies = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-http-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

it.effect("T3 owns voice HTTP, socket authentication, credential renewal and shutdown", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const server = yield* HttpServer.HttpServer;
    const sessions = yield* SessionStore.SessionStore;
    const client = yield* HttpClient.HttpClient;
    if (server.address._tag === "UnixPathAddress") throw new Error("Expected TCP test server");
    const origin = `http://127.0.0.1:${server.address.port}`;
    const configFile = path.join(config.baseDir, "voice.env");
    yield* fs.writeFileString(configFile, "QWEN_AUDIO_LOG_LEVEL=error\n");
    vi.stubEnv("T3_VOICE_ENABLED", "1");
    vi.stubEnv("T3_VOICE_PORT", "0");
    vi.stubEnv("VOICE_CONFIG_FILE", configFile);
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const fakeT3 = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/api/orchestration/shell",
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({
            projects: [{ id: "project", workspaceRoot: config.baseDir }],
            threads: [{ id: "thread", projectId: "project", title: "Voice" }],
          }),
        ),
      ),
      HttpRouter.add(
        "GET",
        "/api/orchestration/threads/thread",
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ projection: { thread: {}, messages: [], runs: [] } }),
        ),
      ),
      HttpRouter.add(
        "GET",
        "/api/voice/catalogue",
        Effect.succeed(HttpServerResponse.jsonUnsafe({ providers: [], capabilities: [] })),
      ),
    );
    yield* Layer.build(
      HttpRouter.serve(
        Layer.mergeAll(fakeT3, voiceGatewayRouteLayer.pipe(Layer.provide(FetchHttpClient.layer))),
        { disableLogger: true },
      ),
    );
    const pairing = yield* sessions.issue({
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    });
    const readOnly = yield* sessions.issue({ scopes: [AuthOrchestrationReadScope] });
    const url = "/voice/t3-connect?thread=thread&format=json";
    expect((yield* client.get(url)).status).toBe(401);
    expect((yield* client.get(url, { headers: { authorization: "Bearer expired" } })).status).toBe(
      401,
    );
    expect(
      (yield* client.get(url, { headers: { authorization: `Bearer ${readOnly.token}` } })).status,
    ).toBe(403);
    const binding = yield* client.get(url, {
      headers: { authorization: `Bearer ${pairing.token}` },
    });
    const bindingText = yield* binding.text;
    expect(binding.status, bindingText).toBe(200);
    expect(bindingText).toContain("sessionId");
    expect(
      (yield* client.get(url, { headers: { cookie: `${sessions.cookieName}=${pairing.token}` } }))
        .status,
    ).toBe(200);
    const voiceBefore = (yield* sessions.listActive()).filter(
      (session) => session.client.label === "T3 voice gateway",
    );
    expect(voiceBefore).toHaveLength(1);
    expect(voiceBefore[0]?.scopes).toEqual([
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
    ]);
    yield* TestClock.adjust("56 minutes");
    expect(
      (yield* client.get(url, { headers: { authorization: `Bearer ${pairing.token}` } })).status,
    ).toBe(200);
    const voiceAfter = (yield* sessions.listActive()).filter(
      (session) => session.client.label === "T3 voice gateway",
    );
    expect(voiceAfter).toHaveLength(1);
    expect(voiceAfter[0]?.sessionId).not.toBe(voiceBefore[0]?.sessionId);
    // Exercise a real Upgrade through the T3 port with the Android bearer header.
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = new NodeSocket.NodeWS.WebSocket(
            origin.replace("http:", "ws:") + "/voice/api/realtime?sessionId=test",
            {
              headers: { authorization: `Bearer ${pairing.token}` },
            },
          );
          socket.once("error", reject);
          socket.once("open", () => socket.close());
          socket.once("close", () => resolve());
        }),
    );
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = new NodeSocket.NodeWS.WebSocket(
            origin.replace("http:", "ws:") + "/voice/api/realtime",
          );
          socket.once("open", () => {
            socket.close();
            reject(new Error("Anonymous WebSocket accepted"));
          });
          socket.once("unexpected-response", (_request, response) => {
            expect(response.statusCode).toBe(401);
            response.resume();
            socket.terminate();
            resolve();
          });
          socket.on("error", () => {});
        }),
    );
    expect((yield* client.post("/voice/t3-llm/v1/responses")).status).toBe(401);
  }).pipe(Effect.provide(dependencies)),
);
