# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Architecture

- Single-file Pi extension (`index.ts`) that registers a `clodex` provider with live model catalog and pricing.
- Uses Pi public APIs (`getAgentDir()`, `readStoredCredential()`) for credential and config paths — do not hardcode `HOME`-based paths.
- Pi stores credentials in `{ type: "api_key", key: "..." }` format in `auth.json`; use `readStoredCredential()` not raw JSON parsing.
- Model cache goes to `getAgentDir()/extensions/pi-clodex/models.json`.
- `CLODEX_API_KEY` env var is the fallback when no stored credential exists.

## Testing

- `node --test test/pi-harness-pricing.test.mjs` — regression tests for credential path handling and pricing computation.
- No build step; Pi loads `index.ts` directly via jiti.

## Package management

- No lockfile in this repo; it's a single-file Pi package with only a `peerDependencies` on `@earendil-works/pi-coding-agent`.
- Installed via `pi install git:github.com/litezevi/pi-clodex`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
