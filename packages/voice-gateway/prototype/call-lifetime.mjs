/** Bound abandoned joins and disconnected callers, never the length of a connected call. */
export function callLifetime({ close, schedule = setTimeout, cancel = clearTimeout }) {
  let timer;
  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const disconnected = () => {
    clear();
    timer = schedule(() => {
      timer = undefined;
      close();
    }, 60_000);
    timer?.unref?.();
  };
  disconnected();
  return { connected: clear, disconnected, close: clear };
}
