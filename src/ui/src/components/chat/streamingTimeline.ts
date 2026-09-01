/**
 * In-flight assistant stream as an ordered list of blocks.
 *
 * Claude's API interleaves thinking / tool_use / text in arrival order.
 * Claudette used to bucket those into three lanes (all thinking, then all
 * text, then all tools), which hid earlier blocks once a later tool call
 * started and showed first-arriving content last.
 */

export type StreamingTimelineItem =
  | { type: "thinking"; id: string; content: string; active: boolean }
  | { type: "text"; id: string; content: string; active: boolean }
  | { type: "tool"; id: string; toolUseId: string };

export function startStreamingBlock(
  items: readonly StreamingTimelineItem[],
  block:
    | { type: "thinking"; id: string }
    | { type: "text"; id: string }
    | { type: "tool"; id: string; toolUseId: string },
): StreamingTimelineItem[] {
  const frozen = items.map((item) =>
    item.type === "thinking" || item.type === "text"
      ? { ...item, active: false }
      : item,
  );
  if (block.type === "tool") {
    if (frozen.some((item) => item.type === "tool" && item.toolUseId === block.toolUseId)) {
      return frozen;
    }
    return [
      ...frozen,
      { type: "tool", id: block.id, toolUseId: block.toolUseId },
    ];
  }
  return [
    ...frozen,
    { type: block.type, id: block.id, content: "", active: true },
  ];
}

export function appendStreamingDelta(
  items: readonly StreamingTimelineItem[],
  type: "thinking" | "text",
  text: string,
): StreamingTimelineItem[] {
  if (!text) return items.slice();
  const next = items.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const item = next[i];
    if (item.type === type && item.active) {
      next[i] = { ...item, content: item.content + text };
      return next;
    }
  }
  next.push({
    type,
    id: `${type}-${next.length}`,
    content: text,
    active: true,
  });
  return next;
}

export function toolUseIdsInTimeline(
  items: readonly StreamingTimelineItem[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.type === "tool") ids.add(item.toolUseId);
  }
  return ids;
}

export function timelineHasVisibleContent(
  items: readonly StreamingTimelineItem[],
): boolean {
  return items.some((item) =>
    item.type === "tool" ? true : item.content.length > 0,
  );
}
