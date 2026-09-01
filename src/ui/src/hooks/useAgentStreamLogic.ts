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

/** Last User index, or -1. A turn's assistant blocks sit after this. */
export function lastUserIndex<T extends { role: string }>(messages: readonly T[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "User") return i;
  }
  return -1;
}

function mergeAssistantFields<
  T extends { content: string; thinking?: string | null },
>(live: T, persisted: T): T {
  return {
    ...live,
    ...persisted,
    thinking: persisted.thinking || live.thinking,
    content: persisted.content || live.content,
  };
}

/** Same id → merge (keep live text if persist is still empty). New id → append. Never match by content. */
export function upsertPersistedMessageById<
  T extends { id: string; content: string; thinking?: string | null },
>(live: T[], persisted: T): T[] {
  const idx = live.findIndex((msg) => msg.id === persisted.id);
  if (idx < 0) return [...live, persisted];
  return live.map((msg, i) =>
    i === idx ? mergeAssistantFields(msg, persisted) : msg,
  );
}

/** Fill thinking on this turn's thinking row (empty content), not an older text row. */
export function applyCompleteAssistantThinking<
  T extends { id: string; role: string; content: string; thinking?: string | null },
>(
  msgs: T[],
  liveId: string | null | undefined,
  _text: string,
  thinking: string,
): T[] {
  const incoming = thinking.trim();
  if (!incoming) return msgs;
  const turnStart = lastUserIndex(msgs) + 1;
  let idx = -1;
  if (liveId) {
    const liveIdx = msgs.findIndex((msg) => msg.id === liveId);
    if (
      liveIdx >= turnStart &&
      msgs[liveIdx]?.role === "Assistant" &&
      !msgs[liveIdx]!.content.trim()
    ) {
      idx = liveIdx;
    }
  }
  if (idx < 0) {
    for (let i = msgs.length - 1; i >= turnStart; i--) {
      if (msgs[i]?.role === "Assistant" && !msgs[i]!.content.trim()) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) return msgs;
  const existing = msgs[idx]!.thinking || "";
  if (existing.trim()) return msgs;
  return msgs.map((msg, i) => (i === idx ? { ...msg, thinking } : msg));
}
