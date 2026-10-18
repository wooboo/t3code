import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "./auth/http.ts";
import { VoiceGateway, voiceGatewayLayer } from "./voiceGateway.ts";

export const voiceGatewayRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* VoiceGateway;
    return HttpRouter.add(
      "*",
      "/voice/*",
      Effect.gen(function* () {
        if (!gateway || gateway.closed) return HttpServerResponse.empty({ status: 503 });
        const request = yield* HttpServerRequest.HttpServerRequest;
        const route = request.url.slice("/voice".length);
        const pathname = route.split("?")[0];
        const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
        // The speech service has its own bridge secret, checked by the gateway.
        const modelBridge =
          request.method === "POST" &&
          (pathname === "/t3-llm/v1/responses" || pathname === "/t3-llm/v1/chat/completions");
        if (!modelBridge) {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const session = yield* (
            upgrade
              ? auth.authenticateWebSocketUpgrade(request)
              : auth.authenticateHttpRequest(request)
          ).pipe(
            Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
              failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
            ),
            Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
              failEnvironmentInternal("internal_error", error),
            ),
          );
          if (!session.scopes.includes(AuthOrchestrationOperateScope))
            return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
        }
        if (upgrade) {
          if (pathname !== "/api/realtime") return HttpServerResponse.empty({ status: 404 });
          const downstream = yield* request.upgrade;
          const upstream = yield* Socket.makeWebSocket(
            gateway.origin.replace("http:", "ws:") + route,
          );
          const writeDownstream = yield* downstream.writer;
          const writeUpstream = yield* upstream.writer;
          return yield* Effect.raceFirst(
            pumpFrames(downstream, writeUpstream),
            pumpFrames(upstream, writeDownstream),
          );
        }
        const http = yield* HttpClient.HttpClient;
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : HttpBody.uint8Array(
                new Uint8Array(yield* request.arrayBuffer),
                request.headers["content-type"],
              );
        const response = yield* http.execute(
          HttpClientRequest.make(request.method)(gateway.origin + route, {
            // Client authentication terminates at T3. Only the speech bridge needs its bearer forwarded.
            headers: {
              ...(request.headers["content-type"]
                ? { "content-type": request.headers["content-type"] }
                : {}),
              ...(modelBridge && request.headers.authorization
                ? { authorization: request.headers.authorization }
                : {}),
            },
            ...(body ? { body } : {}),
          }),
        );
        return HttpServerResponse.fromClientResponse(response);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
  }),
).pipe(Layer.provide(voiceGatewayLayer));

const pumpFrames = Effect.fn("VoiceGatewayHttp.pumpFrames")(function* (
  source: Socket.Socket,
  sink: Socket.Writer,
) {
  const { pull } = yield* source.reader;
  while (true) {
    yield* sink.writeAll(yield* pull);
  }
});
