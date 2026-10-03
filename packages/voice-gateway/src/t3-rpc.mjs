import WebSocket from "ws";

/** Submit through the same authenticated protocol-v2 RPC as web and mobile. */
export async function dispatchT3Command({ origin, token, command, signal }) {
  const endpoint = new URL("/ws", origin);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  endpoint.searchParams.set("orchestrationProtocol", "2");
  const credential = typeof token === "function" ? await token() : token;
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]);
  deadline.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${credential}` },
      maxPayload: 1_000_000,
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener("abort", aborted);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
      if (error) reject(error);
      else resolve(value);
    };
    const aborted = () => finish(deadline.reason);
    deadline.addEventListener("abort", aborted, { once: true });
    socket.on("error", (error) => finish(error));
    socket.on("close", () =>
      finish(new Error("T3 command connection closed before acknowledgement")),
    );
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: "orchestration.dispatchCommand",
          payload: command,
          headers: [],
        }),
      ),
    );
    socket.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response._tag !== "Exit" || response.requestId !== "1") return;
        if (response.exit._tag === "Success") finish(null, response.exit.value);
        else finish(new Error("T3 rejected the voice command; check the thread before retrying"));
      } catch (error) {
        finish(error);
      }
    });
  });
}
