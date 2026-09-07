import type { StreamEvent } from "../types/agent-events";
import type { TurnUsage } from "../stores/useAppStore";

type ResultEvent = Extract<StreamEvent, { type: "result" }>;
type UsageBlock = NonNullable<ResultEvent["usage"]>;
type Iteration = NonNullable<UsageBlock["iterations"]>[number];

function toMeterUsage(source: UsageBlock | Iteration): TurnUsage {
  return {
    totalTokens: source.total_tokens ?? undefined,
    inputTokens: source.input_tokens,
    outputTokens: source.output_tokens,
    cacheReadTokens: source.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: source.cache_creation_input_tokens ?? undefined,
    modelContextWindow: source.model_context_window ?? undefined,
  };
}

/**
 * Pick the per-call usage for the ContextMeter from a `result` stream event.
 *
 * `result.usage.iterations` are per-API-call snapshots. The last entry is the
 * final call's occupancy (what the meter should show). The top-level
 * `result.usage.*` fields aggregate across every internal tool-use iteration
 * and are `num_turns ×` too large — using them is how the meter can read
 * 4.4M / 1.0M.
 *
 * Codex reports a runtime `model_context_window` on the top-level usage and
 * typically has no `iterations`; that path still uses the top-level block.
 * Claude aggregates without iterations are ignored so a live `message_delta`
 * occupancy is not overwritten.
 */
export function pickMeterUsageFromResult(
  event: ResultEvent,
): TurnUsage | null {
  const iterations = event.usage?.iterations;
  if (iterations && iterations.length > 0) {
    return toMeterUsage(iterations[iterations.length - 1]!);
  }
  const source = event.usage;
  if (!source) return null;
  if (!Number.isFinite(source.model_context_window)) return null;
  if (
    typeof source.input_tokens !== "number" &&
    typeof source.output_tokens !== "number"
  ) {
    return null;
  }
  return toMeterUsage(source);
}
