/** Begin the silence window only once the caller's microphone is connected. */
export function callerReadiness({ ask, interrupt, schedule = setTimeout, cancel = clearTimeout }) {
  let connected = false;
  let ready = false;
  let asked = false;
  let speaking = false;
  let closed = false;
  let timer;
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const arm = () => {
    clear();
    if (!connected || ready || asked || speaking || closed) return;
    timer = schedule(() => {
      timer = undefined;
      if (closed || ready || speaking || asked) return;
      asked = true;
      ask("Jest tam kto?");
    }, 3000);
    timer?.unref?.();
  };
  return {
    get ready() {
      return ready;
    },
    connected() {
      connected = true;
      arm();
    },
    speaking(value) {
      speaking = value;
      if (value) {
        clear();
        if (asked && !ready && !closed) interrupt();
      } else arm();
    },
    transcript(text) {
      if (!text.trim() || closed) return;
      ready = true;
      clear();
    },
    close() {
      closed = true;
      clear();
    },
  };
}
