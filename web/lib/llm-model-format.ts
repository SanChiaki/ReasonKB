export type LlmInterfaceFormat = "openai-compatible" | "anthropic-messages";

const providerByInterfaceFormat: Record<LlmInterfaceFormat, string> = {
  "openai-compatible": "openai",
  "anthropic-messages": "anthropic",
};

export function buildLlmModel(
  interfaceFormat: LlmInterfaceFormat,
  modelName: string,
) {
  const normalizedModelName = modelName.trim();
  const provider = providerByInterfaceFormat[interfaceFormat];
  return `${provider}/${normalizedModelName}`;
}

export function splitLlmModel(model: string): {
  interfaceFormat: LlmInterfaceFormat;
  modelName: string;
} {
  const normalized = model.trim();
  if (normalized.startsWith("anthropic/")) {
    return {
      interfaceFormat: "anthropic-messages",
      modelName: normalized.slice("anthropic/".length),
    };
  }
  if (normalized.startsWith("openai/")) {
    return {
      interfaceFormat: "openai-compatible",
      modelName: normalized.slice("openai/".length),
    };
  }
  return {
    interfaceFormat: "openai-compatible",
    modelName: normalized,
  };
}
