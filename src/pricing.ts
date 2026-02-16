import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const CACHE_PATH = path.join(OPENCLAW_HOME, "costguard-pricing.json");
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

// key = litellm model name, value = per-token costs from JSON
interface RawEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
}

let pricingMap: Map<string, ModelPricing> | null = null;
let matchCache: Map<string, { key: string; pricing: ModelPricing } | null> = new Map();

function parseRaw(data: Record<string, any>): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [key, entry] of Object.entries(data)) {
    if (key === "sample_spec" || typeof entry !== "object" || !entry) continue;
    const inCost = entry.input_cost_per_token;
    const outCost = entry.output_cost_per_token;
    if (typeof inCost !== "number" || typeof outCost !== "number") continue;
    const p: ModelPricing = {
      inputPerMillion: inCost * 1_000_000,
      outputPerMillion: outCost * 1_000_000,
    };
    const cr = entry.cache_read_input_token_cost;
    const cw = entry.cache_creation_input_token_cost;
    if (typeof cr === "number") p.cacheReadPerMillion = cr * 1_000_000;
    if (typeof cw === "number") p.cacheWritePerMillion = cw * 1_000_000;
    map.set(key, p);
  }
  return map;
}

function loadCache(): Map<string, ModelPricing> | null {
  try {
    const stat = fs.statSync(CACHE_PATH);
    if (Date.now() - stat.mtimeMs > CACHE_MAX_AGE_MS) return null;
    return parseRaw(JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")));
  } catch { return null; }
}

function saveCache(raw: string): void {
  try { fs.writeFileSync(CACHE_PATH, raw, "utf-8"); } catch {}
}

export async function refreshPricing(): Promise<{ count: number; source: string }> {
  // Try remote fetch
  try {
    const res = await fetch(LITELLM_URL);
    if (res.ok) {
      const text = await res.text();
      const parsed = parseRaw(JSON.parse(text));
      if (parsed.size > 0) {
        pricingMap = parsed;
        matchCache = new Map();
        saveCache(text);
        return { count: parsed.size, source: "litellm-remote" };
      }
    }
  } catch {}
  // Fallback to local cache
  const cached = loadCache();
  if (cached && cached.size > 0) {
    pricingMap = cached;
    matchCache = new Map();
    return { count: cached.size, source: "local-cache" };
  }
  return { count: 0, source: "none" };
}

// Fuzzy match: find the best matching key for a model name
function fuzzyFind(model: string): { key: string; pricing: ModelPricing } | null {
  if (!pricingMap) return null;
  const cached = matchCache.get(model);
  if (cached !== undefined) return cached;

  const norm = model.toLowerCase();
  // 1. exact match
  const exact = pricingMap.get(norm) ?? pricingMap.get(model);
  if (exact) { matchCache.set(model, { key: model, pricing: exact }); return matchCache.get(model)!; }

  // 2. strip common prefixes (provider aliases like "claude-proxy" → look for bare model)
  let best: { key: string; score: number; pricing: ModelPricing } | null = null;
  for (const [key, pricing] of pricingMap) {
    // skip regional/fast variants unless exact
    if (key.includes("/") && !norm.includes("/")) {
      const bare = key.split("/").pop()!;
      if (bare === norm) { matchCache.set(model, { key, pricing }); return matchCache.get(model)!; }
    }
    const score = similarity(norm, key);
    if (!best || score > best.score) best = { key, score, pricing };
  }

  const result = best && best.score >= 0.6 ? { key: best.key, pricing: best.pricing } : null;
  matchCache.set(model, result);
  return result;
}

// Dice coefficient on bigrams — lightweight, no deps
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const bg = s.slice(i, i + 2); m.set(bg, (m.get(bg) ?? 0) + 1); } return m; };
  const aB = bigrams(a), bB = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of aB) overlap += Math.min(count, bB.get(bg) ?? 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): { cost: number; matchedModel: string | null } {
  const match = fuzzyFind(model);
  if (!match) return { cost: 0, matchedModel: null };
  const p = match.pricing;
  const cost =
    (inputTokens / 1_000_000) * p.inputPerMillion +
    (outputTokens / 1_000_000) * p.outputPerMillion +
    (cacheReadTokens / 1_000_000) * (p.cacheReadPerMillion ?? p.inputPerMillion) +
    (cacheWriteTokens / 1_000_000) * (p.cacheWritePerMillion ?? p.inputPerMillion);
  return { cost, matchedModel: match.key };
}

export function getKnownModels(): string[] {
  return pricingMap ? [...pricingMap.keys()] : [];
}

export function isPricingLoaded(): boolean {
  return pricingMap !== null && pricingMap.size > 0;
}
