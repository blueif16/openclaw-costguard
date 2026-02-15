export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

// Prices as of Feb 2026 — update periodically or fetch from LiteLLM
const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "anthropic/claude-opus-4-6":       { inputPerMillion: 15,  outputPerMillion: 75,  cacheReadPerMillion: 1.5,  cacheWritePerMillion: 18.75 },
  "anthropic/claude-opus-4-5":       { inputPerMillion: 15,  outputPerMillion: 75,  cacheReadPerMillion: 1.5,  cacheWritePerMillion: 18.75 },
  "anthropic/claude-sonnet-4-5":     { inputPerMillion: 3,   outputPerMillion: 15,  cacheReadPerMillion: 0.3,  cacheWritePerMillion: 3.75 },
  "anthropic/claude-haiku-4-5":      { inputPerMillion: 0.8, outputPerMillion: 4,   cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 },
  // OpenAI
  "openai/gpt-5.2":                  { inputPerMillion: 2.5, outputPerMillion: 10 },
  "openai/gpt-5.2-mini":             { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  // Google
  "google/gemini-2.5-pro":           { inputPerMillion: 1.25, outputPerMillion: 10 },
  "google/gemini-2.5-flash":         { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  // xAI
  "xai/grok-4.1":                    { inputPerMillion: 3,   outputPerMillion: 15 },
  // Minimax
  "minimax/m2.5":                    { inputPerMillion: 0.5, outputPerMillion: 2.0 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0
): number {
  const pricing = PRICING[model];
  if (!pricing) {
    // Try partial match (provider/model variants)
    const match = Object.keys(PRICING).find(k => model.startsWith(k) || model.includes(k.split('/')[1]));
    if (!match) return 0; // Unknown model — log warning, don't crash
    return estimateCost(match, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion);
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion);

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

export function getKnownModels(): string[] {
  return Object.keys(PRICING);
}
