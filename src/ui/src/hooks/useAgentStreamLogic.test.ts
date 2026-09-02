import { describe, expect, it, vi } from "vitest";
import {
  applyCommandLineEvent,
  approvalDetailValue,
  extractAssistantMessageParts,
  firstApprovalDetailString,
  initialToolInputJson,
  livePartFromContentBlockDelta,
  mergeReloadedAssistantThinking,
  upsertPersistedMessageById,
  applyCompleteAssistantThinking,
  activitiesForCheckpointSave,
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

describe("upsertPersistedMessageById", () => {
  it("merges onto the same id and keeps live text the persist has not caught up to", () => {
    const next = upsertPersistedMessageById(
      [{ id: "t1", role: "Assistant", content: "", thinking: "plan the read" }],
      { id: "t1", role: "Assistant", content: "", thinking: "" },
    );
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe("t1");
    expect(next[0]?.thinking).toBe("plan the read");
  });

  it("appends a new id instead of matching another row by content prefix", () => {
    const next = upsertPersistedMessageById(
      [
        { id: "u", role: "User", content: "go", thinking: null },
        { id: "a1", role: "Assistant", content: "规格里已经看到用户账本。", thinking: "t1" },
        { id: "a2", role: "Assistant", content: "规格", thinking: "" },
      ],
      {
        id: "db-2",
        role: "Assistant",
        content: "规格已经对上了。接下来读登录。",
        thinking: null,
      },
    );
    expect(next.map((m) => m.id)).toEqual(["u", "a1", "a2", "db-2"]);
    expect(next[1]?.thinking).toBe("t1");
    expect(next[1]?.content).toBe("规格里已经看到用户账本。");
  });

  it("does not rename a live row when the persist uses a different id", () => {
    const next = upsertPersistedMessageById(
      [{ id: "live-1", role: "Assistant", content: "Done.", thinking: "plan" }],
      { id: "db-1", role: "Assistant", content: "Done.", thinking: "plan" },
    );
    expect(next.map((m) => m.id)).toEqual(["live-1", "db-1"]);
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

describe("activitiesForCheckpointSave", () => {
  it("prefers live tool activities while the turn is still open", () => {
    expect(
      activitiesForCheckpointSave(
        [{ toolUseId: "live" }],
        [{ activities: [{ toolUseId: "done" }] }],
      ),
    ).toEqual([{ toolUseId: "live" }]);
  });

  it("falls back to the last completed turn after ProcessExited cleared live tools", () => {
    expect(
      activitiesForCheckpointSave(
        [],
        [
          { activities: [{ toolUseId: "old" }] },
          { activities: [{ toolUseId: "fastctx-1" }, { toolUseId: "fastctx-2" }] },
        ],
      ),
    ).toEqual([{ toolUseId: "fastctx-1" }, { toolUseId: "fastctx-2" }]);
  });
});
