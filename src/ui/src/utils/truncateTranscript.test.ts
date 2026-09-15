import { describe, it, expect } from "vitest";
import { truncateTranscriptAtUser } from "./truncateTranscript";
import type { ChatMessage } from "../types/chat";
import type { CompletedTurn } from "../stores/slices/chatSlice";

function msg(
  id: string,
  role: "User" | "Assistant",
  extras: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    workspace_id: "ws",
    chat_session_id: "ws",
    role,
    content: extras.content ?? id,
    cost_usd: null,
    duration_ms: null,
    created_at: "",
    thinking: extras.thinking ?? null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}

function turn(
  id: string,
  afterMessageIndex: number,
  ordinals: number[] = [0],
): CompletedTurn {
  return {
    id,
    messageCount: 1,
    collapsed: true,
    afterMessageIndex,
    activities: ordinals.map((ordinal, i) => ({
      toolUseId: `${id}-tool-${i}`,
      toolName: "Read",
      inputJson: "{}",
      resultText: "ok",
      collapsed: true,
      summary: "read",
      assistantMessageOrdinal: ordinal,
    })),
  };
}

describe("truncateTranscriptAtUser", () => {
  const m1 = msg("m1", "User");
  const m2 = msg("m2", "Assistant", { thinking: "plan", content: "" });
  const m3 = msg("m3", "Assistant", { content: "done" });
  const m4 = msg("m4", "User");
  const m5 = msg("m5", "Assistant", { thinking: "later", content: "next" });
  const t1 = turn("t1", 3, [1]);
  const t2 = turn("t2", 5, [0]);
  const messages = [m1, m2, m3, m4, m5];
  const turns = [t1, t2];

  it("drops the clicked user and everything after, keeping earlier objects", () => {
    const result = truncateTranscriptAtUser(messages, turns, "m4");

    expect(result.cutIndex).toBe(3);
    expect(result.messages).toEqual([m1, m2, m3]);
    expect(result.messages[0]).toBe(m1);
    expect(result.messages[1]).toBe(m2);
    expect(result.messages[2]).toBe(m3);
    expect(result.completedTurns).toEqual([t1]);
    expect(result.completedTurns[0]).toBe(t1);
    expect(result.completedTurns[0].activities[0].assistantMessageOrdinal).toBe(
      1,
    );
  });

  it("does not invent a rebuilt turn list for surviving history", () => {
    const result = truncateTranscriptAtUser(messages, turns, "m4");
    expect(result.completedTurns).not.toContain(t2);
    expect(result.completedTurns).toHaveLength(1);
  });

  it("clears everything when fromMessageId is null", () => {
    const result = truncateTranscriptAtUser(messages, turns, null);
    expect(result.cutIndex).toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.completedTurns).toEqual([]);
  });

  it("returns cutIndex -1 and leaves arrays untouched when the user is missing", () => {
    const result = truncateTranscriptAtUser(messages, turns, "missing");
    expect(result.cutIndex).toBe(-1);
    expect(result.messages).toBe(messages);
    expect(result.completedTurns).toBe(turns);
  });

  it("keeps a turn that ended exactly at the cut (previous turn boundary)", () => {
    const result = truncateTranscriptAtUser(messages, turns, "m4");
    expect(result.completedTurns.map((item) => item.id)).toEqual(["t1"]);
  });

  it("accounts for pagination offset when deciding which turns survive", () => {
    const earlier = turn("t-early", 8, [1]);
    const windowTurn = turn("t-window", 13, [1]);
    const undone = turn("t-undone", 15, [0]);
    const result = truncateTranscriptAtUser(
      messages,
      [earlier, windowTurn, undone],
      "m4",
      10,
    );
    // local cut 3 → global cut 13. Turns that ended at or before the
    // clicked user stay (including those on older pages); the undone
    // turn does not.
    expect(result.messages).toEqual([m1, m2, m3]);
    expect(result.completedTurns).toEqual([earlier, windowTurn]);
    expect(result.completedTurns[0]).toBe(earlier);
    expect(result.completedTurns[1]).toBe(windowTurn);
  });
});
