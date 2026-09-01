import { describe, expect, it, vi } from "vitest";
import {
  applyCommandLineEvent,
  approvalDetailValue,
  extractAssistantMessageParts,
  firstApprovalDetailString,
  initialToolInputJson,
  livePartFromContentBlockDelta,
  mergeReloadedAssistantThinking,
  adoptPersistedAssistantIntoLive,
  applyCompleteAssistantThinking,
  reattachPersistedAssistantsKeepingLiveOrder,
  type CommandLineApplyDeps,
} from "./useAgentStreamLogic";

function makeDeps(currentValue: string | null): {
  deps: CommandLineApplyDeps;
  update: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn();
  const persist = vi.fn(async () => undefined);
  return {
    deps: {
      getCurrent: () => currentValue,
      updateSession: update,
      persist,
    },
    update,
    persist,
  };
}

describe("applyCommandLineEvent", () => {
  it("returns false for non-command_line subtypes (no-op)", () => {
    const { deps, update, persist } = makeDeps(null);
    const handled = applyCommandLineEvent(
      { subtype: "task_started", command_line: null },
      "s1",
      deps,
    );
    expect(handled).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns false when command_line is not a string", () => {
    const { deps, update, persist } = makeDeps(null);
    const handled = applyCommandLineEvent(
      { subtype: "command_line", command_line: null },
      "s1",
      deps,
    );
    expect(handled).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("updates + persists when current is null (first emit)", () => {
    const { deps, update, persist } = makeDeps(null);
    const handled = applyCommandLineEvent(
      { subtype: "command_line", command_line: "claude --print …" },
      "s1",
      deps,
    );
    expect(handled).toBe(true);
    expect(update).toHaveBeenCalledWith("s1", "claude --print …");
    expect(persist).toHaveBeenCalledWith("s1", "claude --print …");
  });

  it("short-circuits when current is already non-null (first-emit-wins)", () => {
    const { deps, update, persist } = makeDeps("claude --print existing");
    const handled = applyCommandLineEvent(
      { subtype: "command_line", command_line: "claude --print new" },
      "s1",
      deps,
    );
    expect(handled).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("extractAssistantMessageParts", () => {
  it("combines final text and thinking blocks from the assistant stream event", () => {
    const parts = extractAssistantMessageParts([
      { type: "thinking", thinking: "Check the renderer. " },
      { type: "text", text: "Done" },
      { type: "thinking", thinking: "Reuse ThinkingBlock." },
      { type: "text", text: "." },
    ]);

    expect(parts).toEqual({
      text: "Done.",
      thinking: "Check the renderer. Reuse ThinkingBlock.",
    });
  });

  it("ignores tool and unknown blocks", () => {
    const parts = extractAssistantMessageParts([
      { type: "tool_use", id: "tool-1", name: "Edit" },
      { type: "Unknown" },
      { type: "text", text: "Visible" },
    ]);

    expect(parts).toEqual({ text: "Visible", thinking: "" });
  });
});

describe("livePartFromContentBlockDelta", () => {
  it("maps thinking_delta onto a thinking part", () => {
    expect(
      livePartFromContentBlockDelta(
        { type: "thinking_delta", thinking: "plan the edit" },
        undefined,
        0,
      ),
    ).toEqual({ type: "thinking", text: "plan the edit" });
  });

  it("maps thinking_delta.text when the CLI uses the text field", () => {
    expect(
      livePartFromContentBlockDelta(
        { type: "thinking_delta", text: "via text field" },
        undefined,
        0,
      ),
    ).toEqual({ type: "thinking", text: "via text field" });
  });

  it("treats text_delta on a thinking block index as thinking, not body text", () => {
    expect(
      livePartFromContentBlockDelta(
        { type: "text_delta", text: "still thinking" },
        new Set([2]),
        2,
      ),
    ).toEqual({ type: "thinking", text: "still thinking" });
  });

  it("keeps text_delta on a non-thinking index as body text", () => {
    expect(
      livePartFromContentBlockDelta(
        { type: "text_delta", text: "hello" },
        new Set([0]),
        1,
      ),
    ).toEqual({ type: "text", text: "hello" });
  });
});

describe("mergeReloadedAssistantThinking", () => {
  it("copies live thinking onto DB rows matched by content", () => {
    const merged = mergeReloadedAssistantThinking(
      [
        { role: "User", content: "hi", thinking: null },
        { role: "Assistant", content: "Done.", thinking: null },
      ],
      [{ role: "Assistant", content: "Done.", thinking: "Check the file first." }],
      "",
    );
    expect(merged[1]?.thinking).toBe("Check the file first.");
  });

  it("falls back to timeline thinking when live rows also lack it", () => {
    const merged = mergeReloadedAssistantThinking(
      [{ role: "Assistant", content: "Done.", thinking: null }],
      [{ role: "Assistant", content: "Done.", thinking: null }],
      "Plan the patch.",
    );
    expect(merged[0]?.thinking).toBe("Plan the patch.");
  });

  it("does not overwrite thinking the DB already persisted", () => {
    const merged = mergeReloadedAssistantThinking(
      [{ role: "Assistant", content: "Done.", thinking: "from db" }],
      [{ role: "Assistant", content: "Done.", thinking: "from live" }],
      "from timeline",
    );
    expect(merged[0]?.thinking).toBe("from db");
  });

  it("pairs thinking-only then text in order, not by empty content", () => {
    const merged = mergeReloadedAssistantThinking(
      [
        { role: "Assistant", content: "", thinking: null },
        { role: "Assistant", content: "Done.", thinking: null },
      ],
      [
        { role: "Assistant", content: "", thinking: "plan the read" },
        { role: "Assistant", content: "Done.", thinking: "summarize" },
      ],
      "",
    );
    expect(merged[0]?.thinking).toBe("plan the read");
    expect(merged[1]?.thinking).toBe("summarize");
  });
});

describe("adoptPersistedAssistantIntoLive", () => {
  it("replaces the live UUID when content matches", () => {
    const { messages, adoptedFromId } = adoptPersistedAssistantIntoLive(
      [{ id: "live-1", role: "Assistant", content: "Done.", thinking: "plan" }],
      { id: "db-1", role: "Assistant", content: "Done.", thinking: "plan" },
    );
    expect(adoptedFromId).toBe("live-1");
    expect(messages[0]?.id).toBe("db-1");
    expect(messages).toHaveLength(1);
  });

  it("matches thinking-only rows with empty content", () => {
    const { messages, adoptedFromId } = adoptPersistedAssistantIntoLive(
      [{ id: "live-th", role: "Assistant", content: "", thinking: "plan the read" }],
      { id: "db-th", role: "Assistant", content: "", thinking: "plan the read" },
    );
    expect(adoptedFromId).toBe("live-th");
    expect(messages[0]?.id).toBe("db-th");
  });

  it("adopts a text persist onto this turn's last text block, not by prefix", () => {
    const { messages, adoptedFromId } = adoptPersistedAssistantIntoLive(
      [
        { id: "u", role: "User", content: "go", thinking: null },
        { id: "live-1", role: "Assistant", content: "规格要先改", thinking: null },
      ],
      { id: "db-1", role: "Assistant", content: "规格要先改：整棵跳过。", thinking: null },
    );
    expect(adoptedFromId).toBe("live-1");
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe("规格要先改：整棵跳过。");
  });

  it("does not append when appendIfMissing is false", () => {
    const live = [
      { id: "live-1", role: "Assistant" as const, content: "first", thinking: null },
    ];
    const { messages, adoptedFromId } = adoptPersistedAssistantIntoLive(
      live,
      { id: "db-extra", role: "Assistant", content: "dumped at bottom", thinking: null },
      { mode: "reload", appendIfMissing: false },
    );
    expect(adoptedFromId).toBeNull();
    expect(messages).toEqual(live);
  });

  it("adopts thinking-only onto the thinking row, not the text row", () => {
    const { messages, adoptedFromId } = adoptPersistedAssistantIntoLive(
      [
        { id: "u", role: "User", content: "go", thinking: null },
        { id: "th", role: "Assistant", content: "", thinking: "先扫规格再读源码。" },
        {
          id: "tx",
          role: "Assistant",
          content: "README 提到产品规格在 research/。",
          thinking: "",
        },
      ],
      {
        id: "db-th",
        role: "Assistant",
        content: "",
        thinking: "先扫规格再读源码。",
      },
      { liveId: "tx" },
    );
    expect(adoptedFromId).toBe("th");
    expect(messages).toHaveLength(3);
    expect(messages[1]?.id).toBe("db-th");
    expect(messages[2]?.id).toBe("tx");
    expect(messages[2]?.content).toBe("README 提到产品规格在 research/。");
    expect(messages[2]?.thinking).toBe("");
  });

  it("keeps one thinking block and one text block per tool round", () => {
    const round = (
      live: Array<{ id: string; role: string; content: string; thinking: string | null }>,
      n: number,
    ) => {
      const withThinking = [
        ...live,
        {
          id: `th-${n}`,
          role: "Assistant",
          content: "",
          thinking: `round ${n} thought`,
        },
      ];
      const afterThink = adoptPersistedAssistantIntoLive(
        withThinking,
        {
          id: `db-th-${n}`,
          role: "Assistant",
          content: "",
          thinking: `round ${n} thought`,
        },
      ).messages;
      const withText = [
        ...afterThink,
        {
          id: `tx-${n}`,
          role: "Assistant",
          content: `round ${n} text`,
          thinking: null,
        },
      ];
      return adoptPersistedAssistantIntoLive(
        withText,
        {
          id: `db-tx-${n}`,
          role: "Assistant",
          content: `round ${n} text`,
          thinking: null,
        },
      ).messages;
    };

    let msgs: Array<{
      id: string;
      role: string;
      content: string;
      thinking: string | null;
    }> = [{ id: "u", role: "User", content: "go", thinking: null }];
    msgs = round(msgs, 1);
    msgs = round(msgs, 2);
    msgs = round(msgs, 3);

    const asst = msgs.filter((m) => m.role === "Assistant");
    expect(asst.map((m) => ({ content: m.content, thinking: m.thinking }))).toEqual([
      { content: "", thinking: "round 1 thought" },
      { content: "round 1 text", thinking: null },
      { content: "", thinking: "round 2 thought" },
      { content: "round 2 text", thinking: null },
      { content: "", thinking: "round 3 thought" },
      { content: "round 3 text", thinking: null },
    ]);
  });

  it("does not prefix-match a later text persist onto an earlier assistant", () => {
    const { messages, adoptedFromId } = adoptPersistedAssistantIntoLive(
      [
        { id: "u", role: "User", content: "go", thinking: null },
        { id: "a1", role: "Assistant", content: "规格里已经看到用户账本。", thinking: "t1" },
        { id: "th", role: "Assistant", content: "", thinking: "t2" },
        { id: "a2", role: "Assistant", content: "规格", thinking: "" },
      ],
      {
        id: "db-2",
        role: "Assistant",
        content: "规格已经对上了。接下来读登录。",
        thinking: null,
      },
    );
    expect(adoptedFromId).toBe("a2");
    expect(messages[1]?.thinking).toBe("t1");
    expect(messages[1]?.content).toBe("规格里已经看到用户账本。");
    expect(messages[2]?.thinking).toBe("t2");
    expect(messages[3]?.id).toBe("db-2");
    expect(messages[3]?.content).toBe("规格已经对上了。接下来读登录。");
  });
});

describe("applyCompleteAssistantThinking", () => {
  it("fills thinking on this turn's thinking row, not a later text row", () => {
    const next = applyCompleteAssistantThinking(
      [
        { id: "u", role: "User", content: "go", thinking: null },
        { id: "th", role: "Assistant", content: "", thinking: "" },
        { id: "tx", role: "Assistant", content: "second", thinking: "" },
      ],
      "tx",
      "second",
      "plan the second edit",
    );
    expect(next[1]?.thinking).toBe("plan the second edit");
    expect(next[2]?.thinking).toBe("");
  });
});

describe("reattachPersistedAssistantsKeepingLiveOrder", () => {
  it("keeps live order and does not dump extra DB text at the end", () => {
    const live = [
      { id: "u", role: "User" as const, content: "go", thinking: null },
      { id: "live-a", role: "Assistant" as const, content: "mid", thinking: "plan" },
      { id: "live-b", role: "Assistant" as const, content: "later", thinking: null },
    ];
    const db = [
      { id: "db-a", role: "Assistant" as const, content: "mid", thinking: "plan" },
      { id: "db-b", role: "Assistant" as const, content: "later", thinking: null },
      { id: "db-extra", role: "Assistant" as const, content: "规格先改…", thinking: null },
    ];
    const next = reattachPersistedAssistantsKeepingLiveOrder(live, db);
    expect(next.map((m) => m.id)).toEqual(["u", "db-a", "db-b"]);
    expect(next.map((m) => m.content)).not.toContain("规格先改…");
    expect(next[1]?.thinking).toBe("plan");
  });
});

describe("approvalDetailValue", () => {
  it("formats supported detail values without surfacing raw JSON", () => {
    expect(approvalDetailValue("  /repo  ")).toBe("/repo");
    expect(approvalDetailValue(["read", " write ", ""])).toBe("read, write");
  });

  it("drops unknown object and scalar shapes", () => {
    expect(approvalDetailValue({ foo: "bar" })).toBeNull();
    expect(approvalDetailValue(42)).toBeNull();
    expect(approvalDetailValue(["read", 42])).toBeNull();
  });
});

describe("initialToolInputJson", () => {
  it("preserves non-empty tool input from content_block_start", () => {
    expect(initialToolInputJson({ file_path: "/repo/src/app.ts" })).toBe(
      JSON.stringify({ file_path: "/repo/src/app.ts" }),
    );
  });

  it("ignores empty start input so streamed JSON deltas can append cleanly", () => {
    expect(initialToolInputJson({})).toBe("");
    expect(initialToolInputJson(null)).toBe("");
  });
});

describe("firstApprovalDetailString", () => {
  it("skips empty and unsupported candidates before using a fallback path", () => {
    expect(
      firstApprovalDetailString(
        {
          path: "",
          filePath: 42,
          grantRoot: "  /repo/src/app.ts  ",
        },
        ["path", "filePath", "grantRoot"],
      ),
    ).toBe("/repo/src/app.ts");
  });

  it("returns null when no string candidate can be displayed", () => {
    expect(
      firstApprovalDetailString(
        {
          path: "",
          filePath: ["not", "a", "path"],
          grantRoot: null,
        },
        ["path", "filePath", "grantRoot"],
      ),
    ).toBeNull();
  });
});
