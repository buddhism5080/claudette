// Pure helper extracted from useAgentStream's `case "system"` branch so
// the first-emit-wins / persist semantics for `command_line` events can
// be tested without rendering the hook.

import type { ContentBlock } from "../types/agent-events";

export interface CommandLineEvent {
  subtype: string;
  command_line?: string | null;
}

export interface CommandLineApplyDeps {
  /// Returns the session's currently-stored cli_invocation, or null if
  /// none is recorded yet.
  getCurrent: (sessionId: string) => string | null;
  /// Update the session record in the store with the new invocation.
  updateSession: (sessionId: string, line: string) => void;
  /// Persist via the Tauri command. Errors logged + dropped (banner is
  /// UX-cosmetic).
  persist: (sessionId: string, line: string) => Promise<void>;
}

/// Returns true iff the event was a `command_line` event AND triggered
/// (or short-circuited) one of the apply branches. Returns false when
/// the event isn't a `command_line` event at all (so the caller can
/// fall through to other System subtypes).
export function applyCommandLineEvent(
  event: CommandLineEvent,
  sessionId: string,
  deps: CommandLineApplyDeps,
): boolean {
  if (event.subtype !== "command_line") return false;
  if (typeof event.command_line !== "string") return false;
  const line = event.command_line;
  // First-emit-wins: don't overwrite a captured invocation with a later
  // respawn's argv.
  const current = deps.getCurrent(sessionId);
  if (current !== null && current !== "") return true;
  deps.updateSession(sessionId, line);
  void deps.persist(sessionId, line).catch((e) => {
    console.warn("[stream] persist cli_invocation failed:", e);
  });
  return true;
}

export function approvalDetailValue(value: unknown): string | null {
  if (typeof value === "string") {
    return approvalDetailString(value);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const joined = value
      .map((item) => item.trim())
      .filter(Boolean)
      .join(", ");
    return joined || null;
  }
  return null;
}

function approvalDetailString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function firstApprovalDetailString(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = approvalDetailString(input[key]);
    if (value) return value;
  }
  return null;
}

export function initialToolInputJson(input: unknown): string {
  if (input == null) return "";
  if (
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input as Record<string, unknown>).length === 0
  ) {
    return "";
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

export function thinkingTextFromBlock(block: ContentBlock): string {
  if (block.type !== "thinking") return "";
  if (block.thinking) return block.thinking;
  if ("text" in block && typeof block.text === "string") return block.text;
  return "";
}

export function extractAssistantMessageParts(content: ContentBlock[]): {
  text: string;
  thinking: string;
} {
  return content.reduce(
    (parts, block) => {
      if (block.type === "text") {
        parts.text += block.text;
      } else if (block.type === "thinking") {
        parts.thinking += thinkingTextFromBlock(block);
      }
      return parts;
    },
    { text: "", thinking: "" },
  );
}

/** Map a content_block_delta onto the live chatMessages part. Thinking
 *  blocks sometimes arrive as thinking_delta, sometimes as text_delta on a
 *  block that started as type=thinking. Either must become msg.thinking —
 *  the live StreamingThinkingBlock lane is no longer mounted. */
export function livePartFromContentBlockDelta(
  delta: { type?: string; thinking?: string; text?: string } | undefined,
  thinkingBlockIndexes: Set<number> | undefined,
  index: number,
): { type: "thinking" | "text"; text: string } | null {
  if (!delta || typeof delta !== "object") return null;
  const asThinkingBlock = thinkingBlockIndexes?.has(index) === true;
  if (delta.type === "thinking_delta" || asThinkingBlock) {
    const text = delta.thinking || delta.text || "";
    if (!text) return null;
    return { type: "thinking", text };
  }
  if (delta.type === "text_delta" && delta.text) {
    return { type: "text", text: delta.text };
  }
  return null;
}

/**
 * Checkpoint reload replaces live UUID messages with DB rows. Pair
 * assistants in order so thinking-only rows (empty content) still keep
 * their thinking. Fork/rollback use the DB ids.
 */
export function mergeReloadedAssistantThinking<
  T extends { role: string; content: string; thinking?: string | null },
>(
  dbMessages: T[],
  liveMessages: readonly T[],
  timelineThinking: string,
): T[] {
  return reconcileReloadedTranscript(dbMessages, liveMessages, timelineThinking);
}

export function reconcileReloadedTranscript<
  T extends { role: string; content: string; thinking?: string | null },
>(
  dbMessages: T[],
  liveMessages: readonly T[],
  timelineThinking = "",
): T[] {
  const liveAsst = liveMessages.filter((msg) => msg.role === "Assistant");
  let i = 0;
  const merged = dbMessages.map((msg) => {
    if (msg.role !== "Assistant") return msg;
    const live = liveAsst[i++];
    if (!msg.thinking?.trim() && live?.thinking?.trim()) {
      return { ...msg, thinking: live.thinking };
    }
    return msg;
  });
  if (
    timelineThinking.trim() &&
    !merged.some((msg) => msg.role === "Assistant" && msg.thinking?.trim())
  ) {
    for (let j = merged.length - 1; j >= 0; j--) {
      if (merged[j]?.role === "Assistant") {
        merged[j] = { ...merged[j], thinking: timelineThinking };
        break;
      }
    }
  }
  return merged;
}

export function assistantContentsMatch(live: string, persisted: string): boolean {
  const a = live.trim();
  const b = persisted.trim();
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}

export function adoptPersistedAssistantIntoLive<
  T extends { id: string; role: string; content: string; thinking?: string | null },
>(
  live: T[],
  persisted: T,
  opts: { appendIfMissing?: boolean } = {},
): { messages: T[]; adoptedFromId: string | null } {
  const appendIfMissing = opts.appendIfMissing !== false;
  if (persisted.role !== "Assistant") {
    if (live.some((msg) => msg.id === persisted.id)) {
      return { messages: live, adoptedFromId: persisted.id };
    }
    return {
      messages: appendIfMissing ? [...live, persisted] : live,
      adoptedFromId: null,
    };
  }
  const idx = live.findIndex((msg) => {
    if (msg.id === persisted.id) return true;
    if (msg.role !== "Assistant") return false;
    if (assistantContentsMatch(msg.content, persisted.content)) {
      return true;
    }
    if (!msg.content.trim() && !persisted.content.trim()) {
      const liveThinking = (msg.thinking || "").trim();
      const persistedThinking = (persisted.thinking || "").trim();
      return liveThinking.length > 0 && liveThinking === persistedThinking;
    }
    return false;
  });
  if (idx < 0) {
    return {
      messages: appendIfMissing ? [...live, persisted] : live,
      adoptedFromId: null,
    };
  }
  const oldId = live[idx]!.id;
  const messages = live.map((msg, i) =>
    i === idx
      ? {
          ...msg,
          ...persisted,
          thinking: persisted.thinking || msg.thinking,
          content: persisted.content || msg.content,
        }
      : msg,
  );
  return { messages, adoptedFromId: oldId };
}

/** Checkpoint reload must keep live arrival order. Only swap DB ids / thinking. */
export function reattachPersistedAssistantsKeepingLiveOrder<
  T extends { id: string; role: string; content: string; thinking?: string | null },
>(live: T[], dbMessages: T[]): T[] {
  let next = live;
  for (const dbMsg of dbMessages) {
    if (dbMsg.role !== "Assistant") continue;
    next = adoptPersistedAssistantIntoLive(next, dbMsg, {
      appendIfMissing: false,
    }).messages;
  }
  return mergeReloadedAssistantThinking(next, live, "");
}
