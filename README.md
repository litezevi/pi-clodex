# pi-clodex

Pi coding agent extension to integrate [Clodex.xyz](https://clodex.xyz) as a provider.

Clodex is a unified LLM API gateway offering GPT, Claude, Gemini, Grok, DeepSeek, Qwen, Kimi, MiniMax, and other models through a single OpenAI-compatible endpoint with one API key, shared balance, usage logs, and per-model pricing.

## Features

- **Full model catalog**: Fetches all available models from `https://clodex.xyz/v1/models` on every pi startup.
- **Live pricing**: Pulls real per-model pricing from `https://clodex.xyz/api/pricing` (input, output, cache read/write) so pi can calculate request costs accurately.
- **Cached catalog**: Falls back to the last successfully fetched model list on disk if the API is unreachable.
- **Default models**: Ships with 10 popular models with pricing for offline/first-run use.
- **Smart metadata**: Infers reasoning, input modalities, context window, and max output tokens for known model families.
- **Multi-API support**: Automatically uses `openai-responses` for GPT models and `anthropic-messages` for Claude models via the same gateway.
- **Skips non-chat models**: Embedding, image generation, and audio models are filtered out automatically.

## Installation

```bash
pi install /path/to/pi-clodex
# or, after publishing to npm:
# pi install npm:pi-clodex
```

## Setup

1. Get an API key from [clodex.xyz/register](https://clodex.xyz/register).
2. Save your key in pi:

```bash
pi /login
# Select "clodex" provider and enter your API key
```

Or set the environment variable:

```bash
export CLODEX_API_KEY="your-api-key"
```

3. Select a model:

```bash
pi /model
# Choose any clodex/* model
```

## Available Models (examples)

Clodex routes 50+ models through a single endpoint. The extension auto-discovers all available models with pricing, but commonly includes:

| Model | Input $/1M tokens | Output $/1M tokens | Description |
|-------|---------|----------|-------------|
| `gpt-5.6-sol` | $0.25 | $2.00 | Maximum quality — complex code, architecture, agent tasks |
| `gpt-5.6-terra` | $0.07 | $0.56 | Balanced — daily development, refactoring, tests |
| `gpt-5.6-luna` | $0.063 | $0.504 | Fast — small fixes, diagnostics |
| `claude-opus-5` | $0.85 | $0.85 | Claude's top reasoning model |
| `claude-sonnet-5` | $0.35 | $1.75 | Claude's balanced model |
| `gemini-3.7-flash` | $0.06 | $0.24 | Fast Gemini with 1M context |
| `grok-4.6` | $0.08 | $0.08 | Grok's latest |
| `deepseek-v4-flash` | $0.12 | $0.12 | DeepSeek V4 fast |
| `kimi-k3` | $0.09 | $0.09 | Kimi K3 with 1M context |
| `qwen3.8-max` | $0.17 | $0.17 | Qwen's largest |

Check `https://clodex.xyz/pricing` for the full current catalog.

## Cost Tracking in Pi

Pi automatically calculates and displays the cost of every request using the `cost` field in each model's configuration. When the extension fetches live pricing from the Clodex API, costs are accurate:

- **input** — price per 1M input tokens
- **output** — price per 1M output tokens (computed as `usage_fixed_price × completion_ratio`)
- **cacheRead** — price per 1M cached input tokens (from `cached_usage_fixed_price` or `cache_ratio`)
- **cacheWrite** — price per 1M cache write tokens (from `create_cache_ratio`)

## Configuration

Cached model data is stored in:

```
$PI_CODING_AGENT_DIR/extensions/pi-clodex/models.json
```

Which defaults to `~/.pi/agent/extensions/pi-clodex/models.json`. Delete this file to force a fresh API fetch on next startup.

## API Compatibility

- **Base URL**: `https://clodex.xyz/v1` (OpenAI-compatible clients)
- **Claude Base URL**: `https://clodex.xyz` without `/v1` (Anthropic SDK / Claude Code)
- **API types**: OpenAI Responses API, OpenAI Chat Completions, Anthropic Messages
- **Streaming**: Yes
- **Tool calls**: Yes
- **Auth**: Bearer token

## License

MIT
