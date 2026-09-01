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

export function extractAssistantMessageParts(content: ContentBlock[]): {
  text: string;
  thinking: string;
} {
  return content.reduce(
    (parts, block) => {
      if (block.type === "text") {
        parts.text += block.text;
      } else if (block.type === "thinking") {
        parts.thinking += block.thinking;
      }
      return parts;
    },
    { text: "", thinking: "" },
  );
}

/**
 * Checkpoint reload replaces live UUID messages with DB rows. Those rows
 * often have empty `thinking` because the CLI's assistant event is
 * text-only. Copy thinking from the live messages (matched by content)
 * or from the still-mounted streaming timeline so the block survives
 * turn end.
 */
export function mergeReloadedAssistantThinking<
  T extends { role: string; content: string; thinking?: string | null },
>(
  dbMessages: T[],
  liveMessages: readonly T[],
  timelineThinking: string,
): T[] {
  const liveByContent = new Map<string, string>();
  for (const msg of liveMessages) {
    if (msg.role === "Assistant" && msg.thinking?.trim()) {
      liveByContent.set(msg.content, msg.thinking);
    }
  }
  const merged = dbMessages.map((msg) => {
    if (msg.role !== "Assistant") return msg;
    if (msg.thinking?.trim()) return msg;
    const fromLive = liveByContent.get(msg.content);
    if (fromLive) return { ...msg, thinking: fromLive };
    return msg;
  });
  if (
    timelineThinking.trim() &&
    !merged.some((msg) => msg.role === "Assistant" && msg.thinking?.trim())
  ) {
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i]?.role === "Assistant") {
        merged[i] = { ...merged[i], thinking: timelineThinking };
        break;
      }
    }
  }
  return merged;
}
