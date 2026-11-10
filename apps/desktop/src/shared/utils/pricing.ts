import type { ModelPricing, TokenPricingSettings } from "../api";

export function defaultModelPricing(modelId: string): ModelPricing | null {
  const lower = modelId.toLowerCase();
  if (
    lower.includes("claude-3-7-sonnet") ||
    lower.includes("claude-3.7-sonnet") ||
    lower.includes("claude-3-5-sonnet") ||
    lower.includes("claude-3.5-sonnet") ||
    lower.includes("claude-sonnet-4")
  ) {
    return {
      input_per_million: 3.0,
      output_per_million: 15.0,
      cache_read_per_million: 0.3,
      cache_write_per_million: 3.75,
    };
  }
  if (
    lower.includes("claude-3-5-haiku") ||
    lower.includes("claude-3.5-haiku") ||
    lower.includes("claude-haiku")
  ) {
    return {
      input_per_million: 0.8,
      output_per_million: 4.0,
      cache_read_per_million: 0.08,
      cache_write_per_million: 1.0,
    };
  }
  if (lower.includes("opus")) {
    return {
      input_per_million: 15.0,
      output_per_million: 75.0,
      cache_read_per_million: 1.5,
      cache_write_per_million: 18.75,
    };
  }
  if (lower.includes("gpt-4o-mini")) {
    return {
      input_per_million: 0.15,
      output_per_million: 0.60,
      cache_read_per_million: 0.075,
      cache_write_per_million: 0.15,
    };
  }
  if (lower.includes("gpt-4o")) {
    return {
      input_per_million: 2.50,
      output_per_million: 10.0,
      cache_read_per_million: 1.25,
      cache_write_per_million: 2.50,
    };
  }
  if (lower.includes("o1-mini") || lower.includes("o3-mini")) {
    return {
      input_per_million: 1.10,
      output_per_million: 4.40,
      cache_read_per_million: 0.55,
      cache_write_per_million: 1.10,
    };
  }
  if (lower.includes("o1")) {
    return {
      input_per_million: 15.0,
      output_per_million: 60.0,
      cache_read_per_million: 7.50,
      cache_write_per_million: 15.0,
    };
  }
  if (lower.includes("deepseek-reasoner") || lower.includes("deepseek-r1") || lower.includes("r1")) {
    return {
      input_per_million: 0.55,
      output_per_million: 2.19,
      cache_read_per_million: 0.14,
      cache_write_per_million: 0.55,
    };
  }
  if (lower.includes("deepseek")) {
    return {
      input_per_million: 0.27,
      output_per_million: 1.10,
      cache_read_per_million: 0.07,
      cache_write_per_million: 0.27,
    };
  }
  if (lower.includes("flash-lite")) {
    return {
      input_per_million: 0.0375,
      output_per_million: 0.15,
      cache_read_per_million: 0.01,
      cache_write_per_million: 0.0375,
    };
  }
  if (lower.includes("gemini") && lower.includes("flash")) {
    return {
      input_per_million: 0.075,
      output_per_million: 0.30,
      cache_read_per_million: 0.01875,
      cache_write_per_million: 0.075,
    };
  }
  if (lower.includes("gemini") && lower.includes("pro")) {
    return {
      input_per_million: 1.25,
      output_per_million: 5.0,
      cache_read_per_million: 0.3125,
      cache_write_per_million: 1.25,
    };
  }
  if (lower.includes("gpt-4-turbo") || lower.includes("gpt-4-0125") || lower.includes("gpt-4-1106")) {
    return {
      input_per_million: 10.0,
      output_per_million: 30.0,
      cache_read_per_million: 5.0,
      cache_write_per_million: 10.0,
    };
  }
  return null;
}

export function globalDefaultPricing(pricing: TokenPricingSettings): ModelPricing {
  return {
    input_per_million: pricing.input_per_million,
    output_per_million: pricing.output_per_million,
    cache_read_per_million: pricing.cache_read_per_million,
    cache_write_per_million: pricing.cache_write_per_million,
  };
}

export function effectiveModelPricing(
  pricing: TokenPricingSettings,
  modelHash?: string | null,
  modelId?: string | null,
): ModelPricing {
  if (modelHash && pricing.models?.[modelHash]) {
    return pricing.models[modelHash];
  }
  if (modelId && pricing.models?.[modelId]) {
    return pricing.models[modelId];
  }
  if (modelId) {
    const builtin = defaultModelPricing(modelId);
    if (builtin) return builtin;
  }
  return globalDefaultPricing(pricing);
}

export function isModelCustomized(
  pricing: TokenPricingSettings,
  modelHash?: string | null,
  modelId?: string | null,
): boolean {
  if (modelHash && pricing.models?.[modelHash] !== undefined) {
    return true;
  }
  if (modelId && pricing.models?.[modelId] !== undefined) {
    return true;
  }
  return false;
}
