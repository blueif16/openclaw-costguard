"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshPricing = refreshPricing;
exports.estimateCost = estimateCost;
exports.getKnownModels = getKnownModels;
exports.isPricingLoaded = isPricingLoaded;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || node_path_1.default.join(node_os_1.default.homedir(), ".openclaw");
const CACHE_PATH = node_path_1.default.join(OPENCLAW_HOME, "costguard-pricing.json");
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day
let pricingMap = null;
let matchCache = new Map();
function parseRaw(data) {
    const map = new Map();
    for (const [key, entry] of Object.entries(data)) {
        if (key === "sample_spec" || typeof entry !== "object" || !entry)
            continue;
        const inCost = entry.input_cost_per_token;
        const outCost = entry.output_cost_per_token;
        if (typeof inCost !== "number" || typeof outCost !== "number")
            continue;
        const p = {
            inputPerMillion: inCost * 1_000_000,
            outputPerMillion: outCost * 1_000_000,
        };
        const cr = entry.cache_read_input_token_cost;
        const cw = entry.cache_creation_input_token_cost;
        if (typeof cr === "number")
            p.cacheReadPerMillion = cr * 1_000_000;
        if (typeof cw === "number")
            p.cacheWritePerMillion = cw * 1_000_000;
        map.set(key, p);
    }
    return map;
}
function loadCache() {
    try {
        const stat = node_fs_1.default.statSync(CACHE_PATH);
        if (Date.now() - stat.mtimeMs > CACHE_MAX_AGE_MS)
            return null;
        return parseRaw(JSON.parse(node_fs_1.default.readFileSync(CACHE_PATH, "utf-8")));
    }
    catch {
        return null;
    }
}
function saveCache(raw) {
    try {
        node_fs_1.default.writeFileSync(CACHE_PATH, raw, "utf-8");
    }
    catch { }
}
async function refreshPricing() {
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
    }
    catch { }
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
function fuzzyFind(model) {
    if (!pricingMap)
        return null;
    const cached = matchCache.get(model);
    if (cached !== undefined)
        return cached;
    const norm = model.toLowerCase();
    // 1. exact match
    const exact = pricingMap.get(norm) ?? pricingMap.get(model);
    if (exact) {
        matchCache.set(model, { key: model, pricing: exact });
        return matchCache.get(model);
    }
    // 2. strip common prefixes (provider aliases like "claude-proxy" → look for bare model)
    let best = null;
    for (const [key, pricing] of pricingMap) {
        // skip regional/fast variants unless exact
        if (key.includes("/") && !norm.includes("/")) {
            const bare = key.split("/").pop();
            if (bare === norm) {
                matchCache.set(model, { key, pricing });
                return matchCache.get(model);
            }
        }
        const score = similarity(norm, key);
        if (!best || score > best.score)
            best = { key, score, pricing };
    }
    const result = best && best.score >= 0.6 ? { key: best.key, pricing: best.pricing } : null;
    matchCache.set(model, result);
    return result;
}
// Dice coefficient on bigrams — lightweight, no deps
function similarity(a, b) {
    if (a === b)
        return 1;
    if (a.length < 2 || b.length < 2)
        return 0;
    const bigrams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) {
        const bg = s.slice(i, i + 2);
        m.set(bg, (m.get(bg) ?? 0) + 1);
    } return m; };
    const aB = bigrams(a), bB = bigrams(b);
    let overlap = 0;
    for (const [bg, count] of aB)
        overlap += Math.min(count, bB.get(bg) ?? 0);
    return (2 * overlap) / (a.length - 1 + b.length - 1);
}
function estimateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
    const match = fuzzyFind(model);
    if (!match)
        return { cost: 0, matchedModel: null };
    const p = match.pricing;
    const cost = (inputTokens / 1_000_000) * p.inputPerMillion +
        (outputTokens / 1_000_000) * p.outputPerMillion +
        (cacheReadTokens / 1_000_000) * (p.cacheReadPerMillion ?? p.inputPerMillion) +
        (cacheWriteTokens / 1_000_000) * (p.cacheWritePerMillion ?? p.inputPerMillion);
    return { cost, matchedModel: match.key };
}
function getKnownModels() {
    return pricingMap ? [...pricingMap.keys()] : [];
}
function isPricingLoaded() {
    return pricingMap !== null && pricingMap.size > 0;
}
