import {
  getAgentDir,
  readStoredCredential,
  type ExtensionAPI,
  type ProviderModelConfig
} from "@earendil-works/pi-coding-agent";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  renameSync
} from "node:fs";
import { join, dirname } from "node:path";

// Security: API key validation bounds
const MIN_API_KEY_LENGTH = 16;
const MAX_API_KEY_LENGTH = 512;

function validateApiKey(apiKey: string): {
  valid: boolean;
  error?: string;
} {
  if (!apiKey || typeof apiKey !== "string") {
    return { valid: false, error: "API key is required" };
  }
  const trimmed = apiKey.trim();
  if (trimmed.length < MIN_API_KEY_LENGTH) {
    return { valid: false, error: `API key too short (minimum ${MIN_API_KEY_LENGTH} characters)` };
  }
  if (trimmed.length > MAX_API_KEY_LENGTH) {
    return { valid: false, error: `API key too long (maximum ${MAX_API_KEY_LENGTH} characters)` };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return { valid: false, error: "API key contains invalid characters" };
  }
  return { valid: true };
}

function validateModel(
  model: ProviderModelConfig,
  index: number
): { valid: boolean; error?: string } {
  if (!model || typeof model !== "object") {
    return { valid: false, error: `Model at index ${index} is not a valid object` };
  }
  if (!model.id || typeof model.id !== "string" || model.id.trim() === "") {
    return { valid: false, error: `Model at index ${index} has invalid or missing id` };
  }
  if (!Array.isArray(model.input) || model.input.length === 0) {
    return { valid: false, error: `Model ${model.id} has invalid or missing input modalities` };
  }
  if (
    typeof model.cost !== "object" ||
    typeof model.cost.input !== "number" ||
    typeof model.cost.output !== "number" ||
    typeof model.cost.cacheRead !== "number" ||
    typeof model.cost.cacheWrite !== "number"
  ) {
    return { valid: false, error: `Model ${model.id} has invalid cost configuration` };
  }
  if (typeof model.contextWindow !== "number" || model.contextWindow <= 0) {
    return { valid: false, error: `Model ${model.id} has invalid contextWindow` };
  }
  if (typeof model.maxTokens !== "number" || model.maxTokens <= 0) {
    return { valid: false, error: `Model ${model.id} has invalid maxTokens` };
  }
  return { valid: true };
}

function validateModels(models: ProviderModelConfig[]): {
  valid: boolean;
  error?: string;
} {
  if (!Array.isArray(models)) return { valid: false, error: "Models must be an array" };
  if (models.length === 0) return { valid: false, error: "At least one model is required" };
  for (let i = 0; i < models.length; i++) {
    const v = validateModel(models[i], i);
    if (!v.valid) return v;
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getModelsFilePath(): string {
  return join(getAgentDir(), "extensions", "pi-clodex", "models.json");
}

function getClodexApiKey(): string | null {
  const credential = readStoredCredential("clodex");
  if (credential?.type === "api_key" && typeof credential.key === "string") {
    const key = credential.key.trim();
    if (key) return key;
  }

  const envKey = process.env.CLODEX_API_KEY?.trim();
  return envKey || null;
}

// ---------------------------------------------------------------------------
// Persisted model cache
// ---------------------------------------------------------------------------

function loadSavedModels(): ProviderModelConfig[] | null {
  const modelsFile = getModelsFilePath();
  try {
    if (existsSync(modelsFile)) {
      const parsed = JSON.parse(readFileSync(modelsFile, "utf-8"));
      if (parsed.models && Array.isArray(parsed.models)) return parsed.models;
    }
  } catch (error) {
    console.error("[pi-clodex] Failed to load saved models:", error);
  }
  return null;
}

function saveModels(models: ProviderModelConfig[]): void {
  const validation = validateModels(models);
  if (!validation.valid) throw new Error(`Model validation failed: ${validation.error}`);

  const modelsFile = getModelsFilePath();
  const backup = existsSync(modelsFile) ? readFileSync(modelsFile, "utf-8") : null;
  const tempFile = modelsFile + ".tmp";

  try {
    const dir = dirname(modelsFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tempFile, JSON.stringify({ updatedAt: new Date().toISOString(), models }, null, 2));
    renameSync(tempFile, modelsFile);
  } catch (error) {
    if (existsSync(tempFile)) try { unlinkSync(tempFile); } catch {}
    if (backup !== null) try { writeFileSync(modelsFile, backup); } catch {}
    console.error("[pi-clodex] Failed to save models:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Clodex API response types
// ---------------------------------------------------------------------------

interface ClodexModelObject {
  id: string;
  name?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  supported_endpoint_types?: string[];
  provider?: string;
  protocols?: string[];
  enabled?: boolean;
  costTier?: string;
  taskRoles?: string[];
  contextWindow?: number;
}

interface ClodexModelsResponse {
  object?: string;
  data: ClodexModelObject[];
}

interface ClodexPricingEntry {
  model_name: string;
  quota_type: number;             // 0 = per-token, 1 = per-request/image
  model_ratio: number;
  model_price: number;            // fixed price for quota_type=1
  completion_ratio: number;       // output = input * completion_ratio
  usage_fixed_price?: number;     // input price per 1M tokens
  usage_floor_price?: number;
  final_price?: number;
  cached_usage_fixed_price?: number; // cache_read price per 1M tokens
  cache_ratio?: number;
  create_cache_ratio?: number;
  vendor_id?: number;
  enable_groups?: string[];
  supported_endpoint_types?: string[];
}

interface ClodexPricingResponse {
  data: ClodexPricingEntry[];
  vendors?: Array<{ id: number; name: string }>;
  supported_endpoint?: Record<string, { path: string; method: string }>;
  success?: boolean;
}

// ---------------------------------------------------------------------------
// Model metadata: known context windows, reasoning, modalities
// ---------------------------------------------------------------------------

interface ModelMeta {
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  api?: string;
  // Whether to skip this model (e.g. embedding-only, image-generation-only)
  skip?: boolean;
}

const modelMeta: Record<string, ModelMeta> = {
  // GPT family
  "gpt-5.6-sol":       { reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 65536, api: "openai-responses" },
  "gpt-5.6-terra":     { reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 65536, api: "openai-responses" },
  "gpt-5.6-luna":      { reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 65536, api: "openai-responses" },
  "gpt-5.5":           { reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 65536, api: "openai-responses" },
  "gpt-image-2":       { skip: true }, // image generation, not chat

  // Claude family
  "claude-opus-5":       { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000, api: "anthropic-messages" },
  "claude-fable-5":      { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000, api: "anthropic-messages" },
  "claude-opus-4-7":     { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000, api: "anthropic-messages" },
  "claude-opus-4-8":     { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000, api: "anthropic-messages" },
  "claude-sonnet-5":     { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000, api: "anthropic-messages" },
  "claude-sonnet-4-6":   { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000, api: "anthropic-messages" },
  "claude-haiku-4-5":    { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000, api: "anthropic-messages" },
  "claude-haiku-4-5-20251001": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000, api: "anthropic-messages" },

  // Gemini family
  "gemini-3.7-flash":       { reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.7-flash-high":  { reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.7-flash-low":   { reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.7-flash-medium":{ reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.6-flash":       { reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },

  // Grok family
  "grok-4.5":               { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 },
  "grok-4.6":               { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 },
  "grok-composer-2.5-fast": { reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 16384 },
  "grok-imagine-video-1.5": { skip: true }, // video generation

  // DeepSeek
  "deepseek-v4-flash": { reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 65536 },
  "deepseek-v4-pro":   { reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 65536 },

  // Qwen
  "qwen3.8-max":  { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 },
  "qwen3.7-max":  { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 },
  "qwen3.7-plus": { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 },
  "qwen3.6-plus": { reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 32768 },
  "qwen3.6-flash":{ reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 32768 },

  // Kimi / Moonshot
  "kimi-k3":                  { reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
  "kimi-k2.7-code":           { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
  "kimi-k2.7-code-highspeed": { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
  "kimi-k2.6":                { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
  "kimi-k2.5":                { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
  "Kimi-K2":                  { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
  "Kimi-K2-Thinking":         { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },

  // MiniMax
  "MiniMax-M3":              { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 65536 },
  "MiniMax-M2.7":            { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 65536 },
  "MiniMax-M2.7-highspeed":  { reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 65536 },
  "MiniMax-M2.5":            { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 65536 },
  "MiniMax-M2.1":            { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 65536 },
  "MiniMax-2.7-highspeed":   { reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 65536 },

  // GLM / Zhipu
  "glm-5.2": { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 65536 },

  // Clodex-specific
  "clodex-cursor":     { reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 65536, api: "openai-responses" },
  "clodex-cursor-pro": { reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 65536, api: "openai-responses" },
  "codex-auto-review": { reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 65536, api: "openai-responses" },

  // Embedding-only models — skip
  "BAAI/bge-m3":            { skip: true },
  "BAAI/bge-reranker-v2-m3":{ skip: true },

  // Image/audio generation — skip
  "qwen-image-2.0":         { skip: true },
  "qwen-image-2.0-pro":     { skip: true },
  "qwen-image-3.0-pro":     { skip: true },
  "qwen-audio-3.0-asr-flash":    { skip: true },
  "qwen-audio-3.0-realtime-plus":{ skip: true },
  "qwen-audio-3.0-tts-plus":     { skip: true },
};

// ---------------------------------------------------------------------------
// Detect model family for unknown models
// ---------------------------------------------------------------------------

function detectFamilyMeta(id: string): ModelMeta {
  const lower = id.toLowerCase();
  if (lower.includes("claude"))  return { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000, api: "anthropic-messages" };
  if (lower.includes("gpt"))     return { reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 };
  if (lower.includes("gemini"))  return { reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 };
  if (lower.includes("grok"))    return { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768 };
  if (lower.includes("deepseek"))return { reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 65536 };
  if (lower.includes("qwen"))    return { reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 32768 };
  if (lower.includes("kimi"))    return { reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 };
  if (lower.includes("minimax")) return { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 65536 };
  if (lower.includes("glm"))     return { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 65536 };
  if (lower.includes("nemotron"))return { reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 16384 };
  if (lower.includes("mistral")) return { reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 65536 };
  return { reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384 };
}

// ---------------------------------------------------------------------------
// API fetching
// ---------------------------------------------------------------------------

async function fetchModelList(apiKey: string): Promise<ClodexModelsResponse | null> {
  try {
    const resp = await fetch("https://clodex.xyz/v1/models", {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` }
    });
    if (!resp.ok) {
      console.error(`[pi-clodex] /v1/models failed: HTTP ${resp.status}`);
      return null;
    }
    return (await resp.json()) as ClodexModelsResponse;
  } catch (error) {
    console.error("[pi-clodex] Failed to fetch model list:", error);
    return null;
  }
}

async function fetchPricing(apiKey: string): Promise<ClodexPricingResponse | null> {
  try {
    const resp = await fetch("https://clodex.xyz/api/pricing", {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` }
    });
    if (!resp.ok) {
      console.error(`[pi-clodex] /api/pricing failed: HTTP ${resp.status}`);
      return null;
    }
    return (await resp.json()) as ClodexPricingResponse;
  } catch (error) {
    console.error("[pi-clodex] Failed to fetch pricing:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convert Clodex data → Pi ProviderModelConfig
// ---------------------------------------------------------------------------

function buildModelConfigs(
  modelList: ClodexModelsResponse,
  pricing: ClodexPricingResponse | null
): ProviderModelConfig[] {
  // Build pricing lookup: model_name → pricing entry
  const pricingMap = new Map<string, ClodexPricingEntry>();
  if (pricing) {
    for (const entry of pricing.data) {
      pricingMap.set(entry.model_name, entry);
    }
  }

  const configs: ProviderModelConfig[] = [];

  for (const model of modelList.data) {
    const id = model.id;

    // Check known metadata first, then detect family
    const meta = modelMeta[id] ?? detectFamilyMeta(id);

    // Skip non-chat models (embedding, image generation, etc.)
    if (meta.skip) continue;

    // Also skip image-generation-only endpoint types
    const endpointTypes = model.supported_endpoint_types ?? [];
    if (endpointTypes.length === 1 && endpointTypes[0] === "image-generation") continue;

    // Get pricing data
    const p = pricingMap.get(id);
    let inputPrice = 0;
    let outputPrice = 0;
    let cacheReadPrice = 0;
    let cacheWritePrice = 0;

    if (p) {
      if (p.quota_type === 0) {
        // Per-token pricing
        // usage_fixed_price = input price per 1M tokens
        inputPrice = p.usage_fixed_price ?? p.final_price ?? 0;
        // output = input * completion_ratio
        const ratio = typeof p.completion_ratio === "number" && p.completion_ratio > 0
          ? p.completion_ratio : 1;
        outputPrice = inputPrice * ratio;
        // cache_read from cached_usage_fixed_price or cache_ratio
        if (p.cached_usage_fixed_price != null) {
          cacheReadPrice = p.cached_usage_fixed_price;
        } else if (typeof p.cache_ratio === "number" && p.cache_ratio > 0) {
          cacheReadPrice = inputPrice * p.cache_ratio;
        }
        // cache_write from create_cache_ratio
        if (typeof p.create_cache_ratio === "number" && p.create_cache_ratio > 0) {
          cacheWritePrice = inputPrice * p.create_cache_ratio;
        }
      }
      // quota_type === 1 is per-request/image pricing; skip for cost tracking
    }

    const contextWindow = meta.contextWindow ?? model.contextWindow ?? 128000;

    configs.push({
      id,
      name: `${id} (Clodex)`,
      reasoning: meta.reasoning ?? false,
      input: meta.input ?? ["text"],
      cost: {
        input: Math.round(inputPrice * 10000) / 10000,
        output: Math.round(outputPrice * 10000) / 10000,
        cacheRead: Math.round(cacheReadPrice * 10000) / 10000,
        cacheWrite: Math.round(cacheWritePrice * 10000) / 10000,
      },
      contextWindow,
      maxTokens: meta.maxTokens ?? 16384,
      ...(meta.api ? { api: meta.api } : {}),
    });
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Default models (used when no API key and no cache)
// ---------------------------------------------------------------------------

const defaultModels: ProviderModelConfig[] = [
  {
    id: "gpt-5.6-sol", name: "GPT-5.6 Sol (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.25, output: 2.0, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 272000, maxTokens: 65536, api: "openai-responses"
  },
  {
    id: "gpt-5.6-terra", name: "GPT-5.6 Terra (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.07, output: 0.56, cacheRead: 0.056, cacheWrite: 0 },
    contextWindow: 272000, maxTokens: 65536, api: "openai-responses"
  },
  {
    id: "gpt-5.6-luna", name: "GPT-5.6 Luna (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.063, output: 0.504, cacheRead: 0.0504, cacheWrite: 0 },
    contextWindow: 272000, maxTokens: 65536, api: "openai-responses"
  },
  {
    id: "claude-opus-5", name: "Claude Opus 5 (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.85, output: 0.85, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000, maxTokens: 32000, api: "anthropic-messages"
  },
  {
    id: "claude-sonnet-5", name: "Claude Sonnet 5 (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.35, output: 1.75, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000, maxTokens: 64000, api: "anthropic-messages"
  },
  {
    id: "gemini-3.7-flash", name: "Gemini 3.7 Flash (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.06, output: 0.24, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576, maxTokens: 65536
  },
  {
    id: "grok-4.6", name: "Grok 4.6 (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.08, output: 0.08, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144, maxTokens: 32768
  },
  {
    id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (Clodex)", reasoning: true,
    input: ["text"],
    cost: { input: 0.12, output: 0.12, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072, maxTokens: 65536
  },
  {
    id: "kimi-k3", name: "Kimi K3 (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.09, output: 0.09, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576, maxTokens: 65536
  },
  {
    id: "qwen3.8-max", name: "Qwen 3.8 Max (Clodex)", reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.17, output: 0.17, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144, maxTokens: 32768
  },
];

// ---------------------------------------------------------------------------
// Resolve models: API → cache → defaults
// ---------------------------------------------------------------------------

async function resolveModels(): Promise<ProviderModelConfig[]> {
  const apiKey = getClodexApiKey();

  if (apiKey) {
    // Fetch both model list and pricing in parallel
    const [modelList, pricing] = await Promise.all([
      fetchModelList(apiKey),
      fetchPricing(apiKey)
    ]);

    if (modelList) {
      const configs = buildModelConfigs(modelList, pricing);
      if (configs.length > 0) {
        const validation = validateModels(configs);
        if (validation.valid) {
          try { saveModels(configs); } catch {}
          console.log(`[pi-clodex] Loaded ${configs.length} models with pricing from API`);
          return configs;
        }
        console.warn(`[pi-clodex] Validation failed: ${validation.error}`);
      }
    }
  } else {
    console.log("[pi-clodex] No API key found. Run /login to add your Clodex key.");
  }

  // Try cache
  const saved = loadSavedModels();
  if (saved) {
    const v = validateModels(saved);
    if (v.valid) {
      console.log(`[pi-clodex] Using ${saved.length} cached models`);
      return saved;
    }
    console.warn(`[pi-clodex] Cached models invalid: ${v.error}`);
  }

  console.log("[pi-clodex] Using default model list");
  return defaultModels;
}

// =============================================================================
// Extension entry point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  const models = await resolveModels();

  pi.registerProvider("clodex", {
    baseUrl: "https://clodex.xyz/v1",
    apiKey: "$CLODEX_API_KEY",
    api: "openai-responses",
    compat: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: true
    },
    models
  });
}
