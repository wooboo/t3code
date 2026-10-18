import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { CodexSettings, ProviderInstanceId, type VoiceInferenceEvent } from "@t3tools/contracts";
import { describe, expect } from "vite-plus/test";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { streamCodexVoice } from "./CodexVoiceStream.ts";

const peer = `
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import assert from 'node:assert/strict';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const params = {threadId:'thread',turnId:'turn',itemId:'message'};
for await (const line of createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  const reply = result => send({id:request.id,result});
  if (request.method === 'initialize') reply({userAgent:'mock',codexHome:process.cwd(),platformFamily:'unix',platformOs:'macos'});
  if (request.method === 'config/read') reply({config:{mcp_servers:{example:{enabled:true}}},origins:{}});
  if (request.method === 'thread/start') {
    assert.equal(request.params.config.mcp_servers.example.enabled,false);
    assert.equal(request.params.ephemeral,true);
    assert.equal(request.params.approvalPolicy,'never');
    assert.equal(request.params.sandbox,'read-only');
    assert(process.argv.includes('features.hooks=false'));
    assert(process.argv.includes('features.shell_tool=false'));
    assert(process.argv.includes('features.plugins=false'));
    reply({cwd:process.cwd(),model:'test',modelProvider:'openai',approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'readOnly'},thread:{id:'thread',projectId:null,sessionId:'session',cwd:process.cwd(),cliVersion:'test',createdAt:0,updatedAt:0,ephemeral:true,modelProvider:'openai',preview:'',source:'appServer',status:{type:'idle'},turns:[]}});
  }
  if (request.method === 'turn/start') {
    assert.equal(request.params.outputSchema.type, 'object');
    assert.equal(request.params.outputSchema.additionalProperties, false);
    assert.deepEqual(request.params.outputSchema.required, ['text', 'toolCalls']);
    reply({turn:{id:'turn',items:[],status:'inProgress'}});
    const socket = createConnection(Number(process.env.CONTROL_PORT),'127.0.0.1',()=> {
      send({method:'item/agentMessage/delta',params:{...params,delta:'{"text":"Już sprawdzam.'}});
    });
    socket.once('data',()=> {
      if(process.env.PEER_MODE === 'exit') process.exit(7);
      const text = process.env.PEER_MODE === 'invalid' ? '{"text":"Już sprawdzam.","toolCalls":"invalid"}' : '{"text":"Już sprawdzam.","toolCalls":[{"name":"delegate","arguments":"{}"}]}';
      send({method:'item/completed',params:{...params,completedAtMs:0,item:{type:'agentMessage',id:'message',text,phase:'final_answer'}}});
      send({method:'turn/completed',params:{...params,turn:{id:'turn',items:[],status:'completed'}}});
    });
  }
}
`;

const decodeSettings = Schema.decodeEffect(CodexSettings);

describe("Codex voice stream", () => {
  for (const mode of ["complete", "invalid", "exit", "cancel"]) {
    it.effect(`delivers text before completion and handles ${mode}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-stream-test-" });
        const control = NodeNet.createServer();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            control.close();
          }),
        );
        yield* Effect.promise(
          () => new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve)),
        );
        const address = control.address();
        if (!address || typeof address === "string") throw Error("Missing control port");
        const connected = new Promise<NodeNet.Socket>((resolve) =>
          control.once("connection", resolve),
        );
        const binaryPath = writeFakeCli({
          directory: cwd,
          name: "codex",
          source: peer,
          env: { CONTROL_PORT: String(address.port), PEER_MODE: mode },
        });
        const settings = yield* decodeSettings({ binaryPath });
        const events: VoiceInferenceEvent[] = [];
        let closed: Promise<unknown> | undefined;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const stream = streamCodexVoice(
          {
            cwd,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
            prompt: "Hello",
          },
          settings,
          process.env,
          spawner,
        );
        const result = yield* stream.pipe(
          Stream.tap((event) =>
            Effect.promise(async () => {
              events.push(event);
              if (events.length === 1) {
                expect(event).toEqual({ type: "text.delta", delta: "Już sprawdzam." });
                const socket = await connected;
                closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
                if (mode !== "cancel") socket.write("finish");
              }
            }),
          ),
          Stream.take(mode === "cancel" ? 1 : Number.MAX_SAFE_INTEGER),
          Stream.runDrain,
          Effect.exit,
        );
        expect(Exit.isFailure(result)).toBe(mode === "invalid" || mode === "exit");
        if (mode === "complete")
          expect(events.at(-1)).toEqual({
            type: "completed",
            result: {
              text: "Już sprawdzam.",
              toolCalls: [{ name: "delegate", arguments: "{}" }],
            },
          });
        else expect(events.map((e) => e.type)).toEqual(["text.delta"]);
        yield* Effect.promise(async () => {
          await closed;
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
