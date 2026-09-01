import { describe, expect, it } from "vitest";

import {
  appendStreamingDelta,
  startStreamingBlock,
  timelineHasVisibleContent,
  toolUseIdsInTimeline,
} from "./streamingTimeline";

describe("streamingTimeline", () => {
  it("keeps thinking, then a tool, then more thinking in arrival order", () => {
    let items = startStreamingBlock([], { type: "thinking", id: "th-0" });
    items = appendStreamingDelta(items, "thinking", "first thought");
    items = startStreamingBlock(items, {
      type: "tool",
      id: "tool-1",
      toolUseId: "tool-1",
    });
    items = startStreamingBlock(items, { type: "thinking", id: "th-1" });
    items = appendStreamingDelta(items, "thinking", "after the tool");

    expect(items.map((item) => item.type)).toEqual([
      "thinking",
      "tool",
      "thinking",
    ]);
    expect(items[0]).toMatchObject({
      type: "thinking",
      content: "first thought",
      active: false,
    });
    expect(items[2]).toMatchObject({
      type: "thinking",
      content: "after the tool",
      active: true,
    });
  });

  it("does not wipe earlier thinking when a tool call starts", () => {
    let items = startStreamingBlock([], { type: "thinking", id: "th-0" });
    items = appendStreamingDelta(items, "thinking", "plan the edit");
    items = startStreamingBlock(items, {
      type: "tool",
      id: "read-1",
      toolUseId: "read-1",
    });
    expect(items[0]).toMatchObject({
      type: "thinking",
      content: "plan the edit",
      active: false,
    });
    expect(timelineHasVisibleContent(items)).toBe(true);
  });

  it("creates a text block from a delta if the backend skipped content_block_start", () => {
    const items = appendStreamingDelta([], "text", "Hello");
    expect(items).toEqual([
      { type: "text", id: "text-0", content: "Hello", active: true },
    ]);
  });

  it("lists tool ids so the live tool lane can skip duplicates", () => {
    let items = startStreamingBlock([], {
      type: "tool",
      id: "a",
      toolUseId: "a",
    });
    items = startStreamingBlock(items, {
      type: "tool",
      id: "b",
      toolUseId: "b",
    });
    expect([...toolUseIdsInTimeline(items)]).toEqual(["a", "b"]);
  });
});
