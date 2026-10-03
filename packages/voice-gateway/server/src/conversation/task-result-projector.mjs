export function recordTaskResult({ conversationSync, ownerId, sessionId, task }) {
  if (!["completed", "failed"].includes(task?.status)) return null;
  return conversationSync.record({
    ownerId,
    sessionId,
    id: `agent:${task.id}`,
    role: "assistant",
    content: task.status === "completed" ? task.result : task.error,
    source: "agent-result",
    turnId: task.turnId,
    taskId: task.id,
  });
}
