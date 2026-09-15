import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentStreamPayload } from "../types/agent-events";
import {
  dropQueuedDeltasForSession,
  isTerminalAgentEvent,
  isTokenDeltaEvent,
  shouldDropStoppedTokenDelta,
  takeQueuedDeltas,
} from "./streamStop";

const delta = (sessionId: string): AgentStreamPayload => ({
  workspace_id: "ws",
  chat_session_id: sessionId,
  event: {
    Stream: {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "x" },
      },
    },
  },
});

describe("streamStop", () => {
  it("identifies content_block_delta as the flood event", () => {
    expect(isTokenDeltaEvent(delta("s").event)).toBe(true);
    const result: AgentEvent = { Stream: { type: "result", subtype: "success" } };
    expect(isTokenDeltaEvent(result)).toBe(false);
    expect(isTerminalAgentEvent(result)).toBe(true);
    expect(isTerminalAgentEvent({ ProcessExited: 0 })).toBe(true);
  });

  it("drops token deltas only after the user has clicked stop", () => {
    expect(shouldDropStoppedTokenDelta(false, delta("s").event)).toBe(false);
    expect(shouldDropStoppedTokenDelta(true, delta("s").event)).toBe(true);
    expect(
      shouldDropStoppedTokenDelta(true, { ProcessExited: null }),
    ).toBe(false);
  });

  it("flushes a bounded batch so the UI thread can take a click", () => {
    const queue = [1, 2, 3, 4, 5];
    expect(takeQueuedDeltas(queue, 2)).toEqual([1, 2]);
    expect(queue).toEqual([3, 4, 5]);
  });

  it("drops queued deltas for the stopped session only", () => {
    const queue = [delta("a"), delta("b"), delta("a")];
    dropQueuedDeltasForSession(queue, "a");
    expect(queue.map((p) => p.chat_session_id)).toEqual(["b"]);
  });
});
