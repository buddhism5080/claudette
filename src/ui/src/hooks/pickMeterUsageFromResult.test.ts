import { describe, it, expect } from "vitest";
import { pickMeterUsageFromResult } from "./pickMeterUsageFromResult";
import type { StreamEvent } from "../types/agent-events";

type ResultEvent = Extract<StreamEvent, { type: "result" }>;

function make(usage: ResultEvent["usage"]): ResultEvent {
  return { type: "result", subtype: "success", usage };
}

describe("pickMeterUsageFromResult", () => {
  it("returns null when usage is null", () => {
    expect(pickMeterUsageFromResult(make(null))).toBeNull();
  });

  it("returns null when usage is undefined (aggregate absent and no iterations)", () => {
    expect(pickMeterUsageFromResult(make(undefined))).toBeNull();
  });

  it("prefers iterations[0] over the top-level aggregate", () => {
    // The top-level fields represent the 69-iteration aggregate; the
    // iteration's fields represent the final API call's per-call usage.
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: 62,
        output_tokens: 41_322,
        cache_creation_input_tokens: 153_239,
        cache_read_input_tokens: 4_695_413,
        iterations: [
          {
            total_tokens: 133_074,
            input_tokens: 1,
            output_tokens: 611,
            cache_read_input_tokens: 131_890,
            cache_creation_input_tokens: 573,
            model_context_window: 272_000,
          },
        ],
      }),
    );
    expect(usage).toEqual({
      totalTokens: 133_074,
      inputTokens: 1,
      outputTokens: 611,
      cacheReadTokens: 131_890,
      cacheCreationTokens: 573,
      modelContextWindow: 272_000,
    });
  });

  it("uses the last iteration when the CLI lists more than one", () => {
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: 62,
        output_tokens: 41_322,
        cache_read_input_tokens: 4_695_413,
        iterations: [
          {
            total_tokens: 10_000,
            input_tokens: 1,
            output_tokens: 10,
            cache_read_input_tokens: 9_000,
          },
          {
            total_tokens: 133_074,
            input_tokens: 2,
            output_tokens: 611,
            cache_read_input_tokens: 131_890,
            cache_creation_input_tokens: 573,
            model_context_window: 272_000,
          },
        ],
      }),
    );
    expect(usage).toEqual({
      totalTokens: 133_074,
      inputTokens: 2,
      outputTokens: 611,
      cacheReadTokens: 131_890,
      cacheCreationTokens: 573,
      modelContextWindow: 272_000,
    });
  });

  it("uses the top-level usage when Codex reports a runtime window and no iterations", () => {
    const usage = pickMeterUsageFromResult(
      make({
        total_tokens: 5_300,
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 5_000,
        model_context_window: 128_000,
      }),
    );
    expect(usage).toEqual({
      totalTokens: 5_300,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 5_000,
      cacheCreationTokens: undefined,
      modelContextWindow: 128_000,
    });
  });

  it("does not use the Claude aggregate when iterations are missing (keep live occupancy)", () => {
    expect(
      pickMeterUsageFromResult(
        make({
          input_tokens: 62,
          output_tokens: 41_322,
          cache_creation_input_tokens: 153_239,
          cache_read_input_tokens: 4_695_413,
        }),
      ),
    ).toBeNull();
  });

  it("does not use an empty iterations array as the Claude aggregate", () => {
    expect(
      pickMeterUsageFromResult(
        make({
          input_tokens: 100,
          output_tokens: 200,
          iterations: [],
        }),
      ),
    ).toBeNull();
  });

  it("treats null cache fields as undefined", () => {
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    );
    expect(usage?.cacheReadTokens).toBeUndefined();
    expect(usage?.cacheCreationTokens).toBeUndefined();
  });

  it("returns null if neither input nor output is present", () => {
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: undefined as unknown as number,
        output_tokens: undefined as unknown as number,
      }),
    );
    expect(usage).toBeNull();
  });
});
