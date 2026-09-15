import type { StateCreator } from "zustand";
import type { ChatMessage, ConversationCheckpoint } from "../../types";
import { extractLatestCallUsage } from "../../utils/extractLatestCallUsage";
import { extractCompactionEvents } from "../../utils/compactionSentinel";
import { truncateTranscriptAtUser } from "../../utils/truncateTranscript";
import type { AppState } from "../useAppStore";

export interface CheckpointsSlice {
  // Keyed by chat session id (matches `listCheckpoints(sessionId)` callers).
  checkpoints: Record<string, ConversationCheckpoint[]>;
  setCheckpoints: (sessionId: string, cps: ConversationCheckpoint[]) => void;
  addCheckpoint: (sessionId: string, cp: ConversationCheckpoint) => void;
  rollbackConversation: (
    sessionId: string,
    workspaceId: string,
    checkpointId: string,
    messages: ChatMessage[],
    /** Clicked user bubble. When present, slice the live transcript instead
     *  of replacing it with the backend list (which remounts earlier turns
     *  and re-buckets tools above thinking/text). `null` is clear-all. */
    fromMessageId?: string | null,
  ) => void;
}

export const createCheckpointsSlice: StateCreator<
  AppState,
  [],
  [],
  CheckpointsSlice
> = (set) => ({
  checkpoints: {},
  setCheckpoints: (sessionId, cps) =>
    set((s) => ({
      checkpoints: { ...s.checkpoints, [sessionId]: cps },
    })),
  addCheckpoint: (sessionId, cp) =>
    set((s) => ({
      checkpoints: {
        ...s.checkpoints,
        [sessionId]: [...(s.checkpoints[sessionId] || []), cp],
      },
    })),
  rollbackConversation: (
    sessionId,
    workspaceId,
    checkpointId,
    messages,
    fromMessageId,
  ) =>
    set((s) => {
      const existingMessages = s.chatMessages[sessionId] || [];
      const existingTurns = s.completedTurns[sessionId] || [];
      const pagination = s.chatPagination[sessionId];
      const globalOffset = pagination
        ? Math.max(0, pagination.totalCount - existingMessages.length)
        : 0;

      // Prefer slicing the live transcript at the clicked user so earlier
      // turns keep their object identity (and therefore their on-screen
      // tool/thinking/text order). Replacing with the backend list remounts
      // every bubble and reconstructCompletedTurns re-buckets tools above
      // thinking/text.
      let nextMessages = messages;
      let nextTurns = existingTurns.slice(0, 0);
      let slicedLocally = false;
      if (fromMessageId === null) {
        nextMessages = [];
        nextTurns = [];
        slicedLocally = true;
      } else if (typeof fromMessageId === "string") {
        const truncated = truncateTranscriptAtUser(
          existingMessages,
          existingTurns,
          fromMessageId,
          globalOffset,
        );
        if (truncated.cutIndex >= 0) {
          nextMessages = truncated.messages;
          nextTurns = truncated.completedTurns;
          slicedLocally = true;
        }
      }

      const { [sessionId]: _q, ...restQuestions } = s.agentQuestions;
      const { [sessionId]: _p, ...restApprovals } = s.planApprovals;
      const { [sessionId]: _a, ...restAgentApprovals } = s.agentApprovals;
      const { [workspaceId]: _cs, ...restChatSearch } = s.chatSearch;
      const lastMsg =
        nextMessages.length > 0
          ? nextMessages[nextMessages.length - 1]
          : undefined;
      const { [workspaceId]: _lm, ...restLastMessages } = s.lastMessages;
      const updatedLastMessages = lastMsg
        ? { ...s.lastMessages, [workspaceId]: lastMsg }
        : restLastMessages;
      const nextCall = extractLatestCallUsage(nextMessages);
      let latestTurnUsage = s.latestTurnUsage;
      if (nextCall) {
        latestTurnUsage = { ...s.latestTurnUsage, [sessionId]: nextCall };
      } else if (sessionId in s.latestTurnUsage) {
        const next = { ...s.latestTurnUsage };
        delete next[sessionId];
        latestTurnUsage = next;
      }
      const nextCompactionEvents = {
        ...s.compactionEvents,
        [sessionId]: extractCompactionEvents(nextMessages),
      };
      const deletedInWindow = existingMessages.length - nextMessages.length;
      const keepWindowPagination = slicedLocally && Boolean(fromMessageId);
      const nextChatPagination =
        sessionId in s.chatPagination
          ? {
              ...s.chatPagination,
              [sessionId]: keepWindowPagination
                ? {
                    hasMore: s.chatPagination[sessionId].hasMore,
                    isLoadingMore: false,
                    totalCount: Math.max(
                      0,
                      s.chatPagination[sessionId].totalCount - deletedInWindow,
                    ),
                    oldestMessageId:
                      nextMessages[0]?.id ??
                      s.chatPagination[sessionId].oldestMessageId,
                  }
                : {
                    hasMore: false,
                    isLoadingMore: false,
                    totalCount: nextMessages.length,
                    oldestMessageId: nextMessages[0]?.id ?? null,
                  },
            }
          : s.chatPagination;
      return {
        chatMessages: { ...s.chatMessages, [sessionId]: nextMessages },
        lastMessages: updatedLastMessages,
        completedTurns: { ...s.completedTurns, [sessionId]: nextTurns },
        toolActivities: { ...s.toolActivities, [sessionId]: [] },
        streamingContent: { ...s.streamingContent, [sessionId]: "" },
        streamingThinking: { ...s.streamingThinking, [sessionId]: "" },
        streamingTimeline: { ...s.streamingTimeline, [sessionId]: [] },
        liveAssistantMessageId: {
          ...s.liveAssistantMessageId,
          [sessionId]: null,
        },
        agentQuestions: restQuestions,
        planApprovals: restApprovals,
        agentApprovals: restAgentApprovals,
        chatSearch: restChatSearch,
        checkpoints: {
          ...s.checkpoints,
          [sessionId]: (() => {
            const current = s.checkpoints[sessionId] || [];
            const target = current.find((c) => c.id === checkpointId);
            if (!target) return [];
            return current.filter((cp) => cp.turn_index <= target.turn_index);
          })(),
        },
        latestTurnUsage,
        compactionEvents: nextCompactionEvents,
        chatPagination: nextChatPagination,
      };
    }),
});
