export function installOfflineNotifications({
  taskManager,
  parentPort,
  delayMs,
  setTimer = setTimeout,
} = {}) {
  return taskManager.subscribe((event) => {
    if (!["task.progress.check", "task.notification.pending"].includes(event.type)) return;
    const timer = setTimer(() => {
      const current = taskManager.get(event.task.id, {
        ownerId: event.ownerId,
      });
      if (!current) return;
      if (event.type === "task.progress.check") {
        if (current.workState !== "active") return;
        parentPort?.postMessage({
          type: "qwen-audio-agent:offline-notification",
          task: {
            id: current.id,
            objective: current.objective,
            result: event.message,
            status: "progress",
          },
        });
        return;
      }
      if (current.notificationStatus !== "pending") return;
      parentPort?.postMessage({
        type: "qwen-audio-agent:offline-notification",
        task: {
          id: current.id,
          objective: current.objective,
          result: current.result,
          error: current.error,
          status: current.status,
        },
      });
    }, delayMs);
    timer.unref?.();
  });
}
