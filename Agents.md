# Agents.md — LLM Gateway Copilot Extension

Central briefing for AI agents working on this codebase. Read `docs/spec.md` for the full technical specification — it contains everything: architecture, wire conversion rules, gateway contracts, and hard-won gotchas (§7 is mandatory reading before touching the picker/schema code).

## What this is

VS Code extension that puts LLM Gateway models into the GitHub Copilot Chat model picker via the stable `vscode.lm.registerLanguageModelChatProvider` API. Thin proxy: all model config, keys, routing, and thinking-effort normalization live in the gateway (`http://localhost:3400` by default). This extension only handles VS Code-side conversion and SSE streaming.

## Non-negotiable constraints

- **Plain JavaScript, CommonJS, zero runtime dependencies.** No TypeScript, no build step, no bundler. `npm install` should never be needed to run it.
- **No defensive coding.** Missing required data throws. No `|| default` for required values, no silent catch. See the fail-fast rules below.
- **The gateway is the source of truth.** Never duplicate provider logic (adapters, effort translation, key management) in the extension. If a model misbehaves, fix the gateway config, not the extension.

## Structure

- [package.json](package.json) — manifest. `contributes.languageModelChatProviders` with vendor `llm-gateway`; commands; `llm-gateway-copilot.*` settings. No `enabledApiProposals`.
- [src/extension.js](src/extension.js) — activate: register provider, commands; activate `github.copilot-chat` first then refresh (else cached picker metadata without `configurationSchema`); refresh on settings change.
- [src/provider.js](src/provider.js) — `createProvider(context)` closure: SecretStorage key (`llm-gateway-copilot.apiKey`), model fetch from `GET /v1/models?type=chat`, `configurationSchema` construction (thinking-effort dropdown), SSE chat loop with tool-call accumulation, cancellation via AbortController.
- [src/convert.js](src/convert.js) — pure VS Code ↔ OpenAI wire conversion. Tool ordering rule: shell message (with `tool_calls`) first, `role:'tool'` results after; pure tool-result messages emit no shell.

## Critical facts (details in spec §7)

1. `configurationSchema.properties.reasoningEffort` needs `group: 'navigation'` and a `title` or Copilot Chat silently ignores it.
2. Picker caches schema aggressively — after schema changes, reload the Extension Development Host; "Refresh Models" alone is insufficient.
3. Dev host SecretStorage is separate from the main window — set the API key inside the dev host.
4. `reasoning_effort: 'none'` = thinking OFF, only honored when declared in the gateway model's `capabilities.thinkingLevels`. Per-adapter support matrix in spec §5/§7.5.
5. `LanguageModelThinkingPart` is proposed API — feature-detect (`typeof ctor === 'function'`), never assume.

## Gateway contract

- `GET {baseUrl}/v1/models?type=chat` → `{ data: [...] }`, each entry spreads `capabilities` verbatim (so `thinkingLevels`, `vision`, `maxOutputTokens` declared in gateway `config.json` reach the extension). Bearer auth via the stored key.
- `POST /v1/chat/completions` — OpenAI chat format, `stream: true`, `stream_options.include_usage: true`. Chunks: `delta.content`, `delta.reasoning_content`, `delta.tool_calls[]` (accumulate per `index`), final usage chunk. Client disconnect aborts upstream.

## Development

- Run: open this folder in VS Code, F5 (needs `.vscode/launch.json` — see spec §8 if missing).
- Logs: Output channel "LLM Gateway Copilot" (`LLM Gateway: Show Logs`).

## Packaging & Release

No automated release pipeline. Releases are cut manually from a clean working copy.

1. **Bump the version** in `package.json` following semver.
2. **Package locally** with the dev-only tool (no `npm install` required):
   ```
   npx @vscode/vsce package
   ```
   This produces `llm-gateway-copilot-<version>.vsix` in the repo root, respecting `.vscodeignore`.
3. **Create a GitHub release** at `https://github.com/herrbasan/llm-gateway-copilot/releases`.
   - Tag the release (e.g. `v0.1.0`).
   - Attach the `.vsix` as a release asset.
   - Copy the relevant changelog notes into the release body.
4. **User install** from the release:
   - Download the `.vsix`.
   - In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → pick the file.
   - Run `LLM Gateway: Set API Key` and pick a model in Copilot Chat.

**Marketplace (optional, not required).** If you ever want the extension in the public VS Code Marketplace, create a publisher at https://marketplace.visualstudio.com/manage, get a Personal Access Token, run `npx vsce login <publisher>` and `npx vsce publish`. The same `.vsix` can also be published to Open VSX via `npx ovsx publish`.

## Coding rules for this repo

- Fail fast, fail loud. No mock data, no fallback defaults, no swallowed errors. A malformed SSE line is logged and skipped (boundary with the network — legitimate); everything internal throws.
- Self-explanatory code over comments. Comment only what the code cannot say (external API quirks, historical context).
- When you fix something non-obvious in the VS Code/Copilot integration, add it to spec §7 — those gotchas cost hours to rediscover.
