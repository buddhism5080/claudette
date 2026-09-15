import type { AgentEvent, AgentStreamPayload } from "../types/agent-events";

/** Token flood during a death-loop reply. These must yield to clicks. */
export function isTokenDeltaEvent(agentEvent: AgentEvent): boolean {
  if (!("Stream" in agentEvent)) return false;
  const streamEvent = agentEvent.Stream;
  if (!("type" in streamEvent) || streamEvent.type !== "stream_event") {
    return false;
  }
  return streamEvent.event?.type === "content_block_delta";
}

export function isTerminalAgentEvent(agentEvent: AgentEvent): boolean {
  if ("ProcessExited" in agentEvent) return true;
  if (!("Stream" in agentEvent)) return false;
  const streamEvent = agentEvent.Stream;
  return "type" in streamEvent && streamEvent.type === "result";
}

export function shouldDropStoppedTokenDelta(
  stopping: boolean,
  agentEvent: AgentEvent,
): boolean {
  return stopping && isTokenDeltaEvent(agentEvent);
}

export const STREAM_DELTA_FLUSH_BATCH = 24;

export function takeQueuedDeltas<T>(
  queue: T[],
  batchSize: number = STREAM_DELTA_FLUSH_BATCH,
): T[] {
  return queue.splice(0, Math.max(0, batchSize));
}

export function dropQueuedDeltasForSession(
  queue: AgentStreamPayload[],
  sessionId: string,
): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].chat_session_id === sessionId) {
      queue.splice(i, 1);
    }
  }
}
