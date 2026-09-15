import type { ChatMessage } from "../types/chat";
import type { CompletedTurn } from "../stores/slices/chatSlice";

export type TruncatedTranscript = {
  messages: ChatMessage[];
  completedTurns: CompletedTurn[];
  /** Local index of the clicked user, or 0 when clearing, or -1 when missing. */
  cutIndex: number;
};

/**
 * Drop the clicked user bubble and everything after it.
 *
 * Surviving rows are the same object identities as `messages` / `completedTurns`
 * — rollback must not rebuild earlier turns from DB (that re-buckets tools
 * above thinking/text).
 *
 * `fromMessageId === null` is clear-all.
 * An unknown id returns the inputs unchanged with `cutIndex: -1`.
 */
export function truncateTranscriptAtUser(
  messages: ChatMessage[],
  completedTurns: CompletedTurn[],
  fromMessageId: string | null,
  globalOffset = 0,
): TruncatedTranscript {
  if (fromMessageId === null) {
    return { messages: [], completedTurns: [], cutIndex: 0 };
  }

  const cutIndex = messages.findIndex((m) => m.id === fromMessageId);
  if (cutIndex < 0) {
    return { messages, completedTurns, cutIndex: -1 };
  }

  const globalCut = globalOffset + cutIndex;
  return {
    messages: messages.slice(0, cutIndex),
    completedTurns: completedTurns.filter(
      (turn) => turn.afterMessageIndex <= globalCut,
    ),
    cutIndex,
  };
}
