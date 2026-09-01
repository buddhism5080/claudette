import { memo, useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { EMPTY_ACTIVITIES, EMPTY_TIMELINE } from "./chatConstants";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolActivitiesSection } from "./ToolActivitiesSection";
import {
  collapseTimelineToolRuns,
  timelineHasVisibleContent,
} from "./streamingTimeline";
import styles from "./ChatPanel.module.css";

/**
 * Live assistant output in API arrival order. Consecutive tool_use blocks
 * are passed to ToolActivitiesSection as a run so grouped mode can merge
 * them into "N tool calls" / one MCP server pill. Thinking and text still
 * break that run.
 */
export const LiveStreamingTimeline = memo(function LiveStreamingTimeline({
  sessionId,
  isStreaming,
  toolDisplayMode,
  searchQuery,
  worktreePath,
}: {
  sessionId: string;
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
  const collapsed = useMemo(
    () => collapseTimelineToolRuns(items),
    [items],
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
          return (
            <div
              key={item.id}
              className={`${styles.message} ${styles.role_Assistant}`}
              data-testid="live-stream-text"
            >
              <div className={styles.content}>{item.content}</div>
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
