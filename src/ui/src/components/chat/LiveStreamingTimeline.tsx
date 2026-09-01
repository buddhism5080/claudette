import { memo, useCallback, useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { tryOpenAgentFileTab } from "../../utils/agentFiles";
import { EMPTY_ACTIVITIES, EMPTY_TIMELINE } from "./chatConstants";
import { monacoFileLinkTarget } from "./chatFileLinks";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";
import { StreamingContext } from "./StreamingContext";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolActivitiesSection } from "./ToolActivitiesSection";
import { useWorkspaceFileIndex } from "./useWorkspaceFileIndex";
import {
  collapseTimelineToolRuns,
  timelineHasVisibleContent,
} from "./streamingTimeline";
import styles from "./ChatPanel.module.css";
import caretStyles from "./caret.module.css";

/**
 * Live assistant output in API arrival order. Consecutive tool_use blocks
 * are passed to ToolActivitiesSection as a run so grouped mode can merge
 * them into "N tool calls" / one MCP server pill. Thinking and text still
 * break that run.
 */
export const LiveStreamingTimeline = memo(function LiveStreamingTimeline({
  sessionId,
  workspaceId,
  isStreaming,
  toolDisplayMode,
  searchQuery,
  worktreePath,
}: {
  sessionId: string;
  workspaceId: string;
  isStreaming: boolean;
  toolDisplayMode: "grouped" | "inline";
  searchQuery: string;
  worktreePath?: string | null;
}) {
  const items = useAppStore(
    (s) => s.streamingTimeline[sessionId] ?? EMPTY_TIMELINE,
  );
  const activities = useAppStore(
    (s) => s.toolActivities[sessionId] ?? EMPTY_ACTIVITIES,
  );
  const openFileTab = useAppStore((s) => s.openFileTab);
  const fileIndex = useWorkspaceFileIndex(workspaceId);
  const collapsed = useMemo(
    () => collapseTimelineToolRuns(items),
    [items],
  );
  const openFileInMonaco = useCallback(
    (filePath: string) => {
      if (tryOpenAgentFileTab(workspaceId, filePath, openFileTab)) return true;
      const target = monacoFileLinkTarget(filePath, worktreePath);
      if (!target) return false;
      openFileTab(workspaceId, target.path, target.revealTarget);
      return true;
    },
    [openFileTab, workspaceId, worktreePath],
  );
  if (!timelineHasVisibleContent(items)) return null;

  return (
    <div data-testid="live-streaming-timeline">
      {collapsed.map((item) => {
        if (item.type === "thinking") {
          if (!item.content) return null;
          return (
            <ThinkingBlock
              key={item.id}
              content={item.content}
              isStreaming={isStreaming && item.active}
              enableTypewriter={isStreaming && item.active}
              inline={toolDisplayMode === "inline"}
              searchQuery={searchQuery}
            />
          );
        }
        if (item.type === "text") {
          if (!item.content) return null;
          const streamingThis = isStreaming && item.active;
          return (
            <div
              key={item.id}
              className={`${styles.message} ${styles.role_Assistant}`}
              data-testid="live-stream-text"
              aria-live="polite"
              aria-busy={streamingThis}
            >
              <div className={styles.content}>
                <StreamingContext.Provider value={streamingThis}>
                  <HighlightedMessageMarkdown
                    content={item.content}
                    query={searchQuery}
                    onOpenFile={openFileInMonaco}
                    resolveFilePath={fileIndex.resolve}
                  />
                </StreamingContext.Provider>
                {streamingThis && (
                  <span className={caretStyles.caret} aria-hidden="true" />
                )}
              </div>
            </div>
          );
        }
        const run = item.toolUseIds
          .map((id) => activities.find((activity) => activity.toolUseId === id))
          .filter((activity): activity is NonNullable<typeof activity> => !!activity);
        if (run.length === 0) return null;
        return (
          <ToolActivitiesSection
            key={item.id}
            sessionId={sessionId}
            toolDisplayMode={toolDisplayMode}
            searchQuery={searchQuery}
            worktreePath={worktreePath}
            activities={run}
          />
        );
      })}
    </div>
  );
});
