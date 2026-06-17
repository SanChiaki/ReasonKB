import { describe, expect, it } from "vitest";
import {
  buildLlmModel,
  splitLlmModel,
} from "@/lib/llm-model-format";

describe("LLM model format helpers", () => {
  it("splits an OpenAI-compatible LiteLLM model into UI fields", () => {
    expect(splitLlmModel("openai/deepseek-v4-flash")).toEqual({
      interfaceFormat: "openai-compatible",
      modelName: "deepseek-v4-flash",
    });
  });

  it("splits an Anthropic LiteLLM model into UI fields", () => {
    expect(splitLlmModel("anthropic/claude-3-5-sonnet-latest")).toEqual({
      interfaceFormat: "anthropic-messages",
      modelName: "claude-3-5-sonnet-latest",
    });
  });

  it("builds the LiteLLM model string on the server boundary", () => {
    expect(buildLlmModel("openai-compatible", "deepseek-v4-flash")).toBe(
      "openai/deepseek-v4-flash",
    );
    expect(buildLlmModel("anthropic-messages", "claude-3-5-sonnet-latest")).toBe(
      "anthropic/claude-3-5-sonnet-latest",
    );
  });
});
