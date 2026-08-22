# LLM Gateway Copilot Extension — Technical Specification

**Date:** 2026-08-22
**Status:** Working prototype, plain JS, zero runtime dependencies
**Workspace:** `llm-gateway-copilot/` (to be moved out of the LLM Gateway repo)

---

## 1. Purpose

Expose LLM Gateway models inside the GitHub Copilot Chat model picker via VS Code's `LanguageModelChatProvider` API. The extension is a thin proxy: it does NOT implement provider API clients. The gateway (default `http://192.168.0.100:3400`) remains the single source of truth for model config, API keys, routing, thinking-effort normalization, and adapter translation.

### Why an extension instead of VS Code's built-in Custom Endpoint (BYOK)

| Feature | Custom Endpoints | This extension |
|---|---|---|
| Thinking content rendering | Plain text only | `LanguageModelThinkingPart` collapsible blocks |
| Thinking effort dropdown | Not available | `configurationSchema` per-model picker |
| Context window display | Unreliable | Direct `maxInputTokens` |
| Tool calling | Fragile SSE parsing | `LanguageModelToolCallPart` |
| Cancellation | HTTP abort only | `CancellationToken` → `AbortController` |

Reference implementations (both TypeScript, heavier):

- `github.com/Vizards/deepseek-v4-for-copilot` — the model for the picker UX, thinking-effort schema, and SecretStorage key handling.
- `github.com/tzraeq/vscode-copilot-custom-provider` — multi-profile Responses-API provider; good documentation of the public API surface vs. internal BYOK behavior.

This project deliberately deviates from both: **plain JavaScript (CommonJS), no build step, no dependencies.**

---

## 2. Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────┐     ┌──────────┐
│  VS Code     │     │ llm-gateway-copilot  │     │ LLM Gateway  │     │ Upstream │
│  Copilot     │────▶│ extension            │────▶│ (localhost)  │────▶│ APIs     │
│  Chat        │◀────│ (LangModelProvider)  │◀────│ :3400        │◀────│          │
└──────────────┘     └─────────────────────┘     └──────────────┘     └──────────┘
                     Plain JS, CJS, no deps      HTTP/SSE proxy       OpenAI/
                     vscode.lm.registerLanguage   Model routing,      Anthropic/
                     ModelChatProvider            adapters, keys      Gemini/etc.
```

### File layout

```
llm-gateway-copilot/
├── package.json          # manifest: contributes.languageModelChatProviders, commands, settings
├── src/
│   ├── extension.js      # activate(): register provider + commands, refresh on config change
│   ├── provider.js       # createProvider(context) closure: key storage, model fetch, SSE loop
│   └── convert.js        # pure VS Code ↔ OpenAI wire conversion (messages, tools, thinking)
└── .vscode/
    └── launch.json       # (to add) F5 → Extension Development Host
```

### Design decisions

1. **Closures, not classes.** `createProvider(context)` returns the provider object; all state (apiKey, models cache, EventEmitter) is closed over. No `this`.
2. **No tokenizer dependency.** `provideTokenCount` estimates `chars/4` (+1020 per image part). The gateway does authoritative token estimation; the extension only needs a stable guess for Copilot's context gauge.
3. **Feature-detection over version gates.** `LanguageModelThinkingPart` is a proposed API — the code checks `typeof vscode.LanguageModelThinkingPart === 'function'` instead of assuming.
4. **Secrets in SecretStorage.** Key stored under `llm-gateway-copilot.apiKey`. Never in settings.json.
5. **Roaming base URL.** `baseUrl` is the primary gateway; `baseUrlCandidates` is an ordered list of fallbacks. On refresh the extension pings them and uses the first reachable one, caching the result until the next refresh or settings change.

---

## 3. package.json manifest (key points)

```json
{
  "engines": { "vscode": "^1.116.0" },
  "main": "./src/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "languageModelChatProviders": [
      { "vendor": "llm-gateway", "displayName": "LLM Gateway" }
    ],
    "commands": [
      "llm-gateway-copilot.setApiKey",
      "llm-gateway-copilot.clearApiKey",
      "llm-gateway-copilot.refreshModels",
      "llm-gateway-copilot.showLogs"
    ],
    "configuration": {
      "llm-gateway-copilot.baseUrl": "http://192.168.0.100:3400",
      "llm-gateway-copilot.baseUrlCandidates": [],
      "llm-gateway-copilot.includeModels": [],
      "llm-gateway-copilot.excludeModels": []
    }
  }
}
```

No `enabledApiProposals` — the provider API (`registerLanguageModelChatProvider`) is stable since ~1.90 and requires VS Code ≥ 1.116 for the picker metadata shape Copilot Chat consumes.

---

## 4. Model discovery → picker

`provideLanguageModelChatInformation`:

1. `GET {baseUrl}/v1/models?type=chat` (Bearer key if set).
2. Filter via `includeModels` / `excludeModels` settings.
3. Map each gateway model to `LanguageModelChatInformation`:
   - `id`, `name` (from `prettyName`), `family: 'llm-gateway'`, `version: '1.0.0'`
   - `maxInputTokens` ← `m.maxInputTokens ?? m.contextWindow`
   - `maxOutputTokens` ← `m.maxOutputTokens ?? m.capabilities.maxOutputTokens`
   - `capabilities.toolCalling` ← `capabilities.toolCalling ?? capabilities.tools ?? true`
   - `capabilities.imageInput` ← `capabilities.vision`
   - `isBYOK: true`, `isUserSelectable: true`
   - Warning icon + detail text when no API key or gateway unreachable.
4. **Thinking-effort dropdown** — iff `capabilities.thinkingLevels` is a non-empty array, attach `configurationSchema`:

```js
info.configurationSchema = {
  type: 'object',
  properties: {
    reasoningEffort: {
      type: 'string',
      title: 'Thinking Effort',
      enum: levels,                        // e.g. ["none","low","high","max"]
      enumItemLabels: levels.map(...),     // none→'Off', xhigh→'Extra High', ...
      default: levels.includes('high') ? 'high' : levels[levels.length - 1],
      description: 'Thinking effort',
      group: 'navigation',                 // CRITICAL — see §7
    },
  },
};
```

### Gateway contract for the picker data

`GET /v1/models` returns `{ object: 'list', data: [...] }`. Each entry spreads the model's `capabilities` object verbatim into `capabilities`, so any field declared in gateway `config.json` (`thinkingLevels`, `vision`, `maxOutputTokens`, ...) reaches the extension. The gateway registry also sets top-level `maxInputTokens`, `contextWindow`, `maxOutputTokens` (see `src/core/model-registry.js` `listModels`).

---

## 5. Request path (chat)

`provideLanguageModelChatResponse(modelInfo, messages, options, progress, token)`:

1. Resolve effort: `options.modelConfiguration.reasoningEffort`, validated against the model's `thinkingLevels`. Invalid/absent → omit (gateway falls back to model's config default).
2. Build body: `{ model, messages: toWireMessages(messages), stream: true, stream_options: { include_usage: true } }`, plus `reasoning_effort` and `tools` (from `toWireTools(options.tools)`) when present.
3. `POST /v1/chat/completions` with `AbortController` wired to `token.onCancellationRequested`. The gateway aborts the upstream provider request on client disconnect.
4. Parse SSE (`sseChunks` async generator over `res.body.getReader()`):
   - `delta.reasoning_content` → `LanguageModelThinkingPart` (if constructor exists)
   - `delta.content` → `LanguageModelTextPart`
   - `delta.tool_calls[]` → accumulated per `index` in a Map (`id`, `function.name`, `function.arguments` string concatenated); flushed as `LanguageModelToolCallPart` on `finish_reason === 'tool_calls'` AND in a `finally` (stream end without explicit finish — prevents dead-end tool flows).
5. Malformed SSE lines are logged and skipped — one corrupt line must not kill the stream.

### Wire conversion rules (convert.js)

- Roles: User → `user`, Assistant → `assistant`, else `system`.
- `LanguageModelTextPart` → text content; images (`LanguageModelDataPart` with `image/*` mime) → `image_url` data-URI parts; when images present, content becomes `[{type:'text',...}, ...images]`.
- `LanguageModelThinkingPart` → `reasoning_content` on the assistant message (round-trip for thinking models; required by Kimi/Moonshot history constraints).
- `LanguageModelToolCallPart` → `tool_calls[]` with `arguments: JSON.stringify(input)`.
- `LanguageModelToolResultPart` → `role: 'tool'` messages with `tool_call_id`.
- **Ordering (fixed 2026-08-22):** the shell message (assistant text/reasoning/tool_calls) is emitted FIRST, then the `role: 'tool'` messages. A message containing only tool results emits NO shell (no spurious `{role:'user', content:null}`). Inverted order is rejected by strict providers (Anthropic-adapter Kimi/DeepSeek).
- Tools: `{ type: 'function', function: { name, description, parameters: inputSchema } }`.

### Gateway-side effort translation (for reference — nothing to implement here)

The extension sends `reasoning_effort`. The gateway router validates it against `capabilities.thinkingLevels` (`nearestEffortLevel` coerces undeclared values; `'none'` only honored when declared — it means OFF, not "lowest"). Then per adapter:

| Adapter | `reasoning_effort` becomes |
|---|---|
| anthropic | `output_config.effort` (`minimal→low, low→low, medium→medium, high→high, xhigh/max→max`); `'none'` → `thinking: { type: 'disabled' }` (omitted for `thinkingMode: 'adaptive'` models) |
| gemini | `generation_config.thinking_level` (enum `minimal\|low\|medium\|high`; no off — `minimal` is the floor) |
| openai | verbatim passthrough if `capabilities.thinkingEffortField === 'reasoning_effort'`; `'none'` support is upstream-dependent |
| openai + `capabilities.thinking === 'chat_template_kwargs'` | router derives `enable_thinking` boolean (`'none'`→false), adapter emits `chat_template_kwargs.enable_thinking` |
| responses | `reasoning.effort` passthrough |

---

## 6. Commands & settings

| Command | Behavior |
|---|---|
| `LLM Gateway: Set API Key` | Input box (password), stored in SecretStorage `llm-gateway-copilot.apiKey`, triggers refresh |
| `LLM Gateway: Clear API Key` | Delete secret, refresh |
| `LLM Gateway: Refresh Models` | Fire `onDidChangeLanguageModelChatInformation` |
| `LLM Gateway: Show Logs` | Show the `LLM Gateway Copilot` output channel |

Settings: `baseUrl` (default `http://192.168.0.100:3400`), `baseUrlCandidates` (fallback URL list for roaming between networks), `includeModels`, `excludeModels`. Changes to any `llm-gateway-copilot.*` setting trigger refresh.

Activation also activates `github.copilot-chat` first, then fires refresh — Copilot Chat can otherwise serve cached model info without `configurationSchema`.

---

## 7. Hard-won gotchas (read before changing anything)

1. **`group: 'navigation'` is mandatory.** Copilot Chat only renders the per-model config UI (the sliders icon next to the model name in the chat input) for `configurationSchema` properties with `group: 'navigation'`. Without it the schema is silently ignored. Also give the property a `title`. (Discovered 2026-08-22 by diffing against the DeepSeek extension's `buildThinkingEffortSchema`.)

2. **The picker caches aggressively.** After changing `configurationSchema` code, a plain "Refresh Models" is NOT enough — reload the Extension Development Host window (F5 restart). Copilot serves cached model metadata otherwise.

3. **Dev host has separate SecretStorage.** The API key set in your main VS Code window is NOT available in the Extension Development Host. You must run Set API Key inside the dev host.

4. **401 / unreachable → error model in the picker.** `provideLanguageModelChatInformation` now returns a single non-selectable `LLM Gateway Error` item with `statusIcon: 'error'` and the error detail when the gateway is unreachable, the fetch fails, or the response shape is wrong. This prevents Copilot from showing stale cached models. The underlying network boundary is still logged.

5. **`'none'` means OFF and is opt-in per model.** The gateway router only honors `reasoning_effort: 'none'` when the model declares it in `thinkingLevels`; undeclared `'none'` is rounded UP to the cheapest declared level. Add `"none"` to a model's `thinkingLevels` in gateway `config.json` only when the adapter/upstream genuinely supports disabling thinking:
   - anthropic adapter: safe (→ `thinking: { type: 'disabled' }`). Done for kimi-k3-chat, kimi-k3-256k-chat, deepseek-chat, deepseek-flash-chat.
   - chat_template_kwargs (llama.cpp/Qwen): safe (→ `enable_thinking: false`).
   - GLM-5.3: NOT possible — API errors on any value outside `low/high/max`, and `thinking.type: disabled` is rejected.
   - Gemini: no off state (`minimal` floor).
   - Grok/GPT: unverified upstream.

6. **No `enabledApiProposals`.** The fields consumed by Copilot Chat (`configurationSchema`, `modelConfiguration`, `isBYOK`, `isUserSelectable`, `statusIcon`) are technically non-public surface, but they are what Copilot Chat reads today — both reference extensions rely on the same shape without declaring proposals. `LanguageModelThinkingPart` is the only truly proposed constructor and is feature-detected.

7. **PowerShell 5.1 + curl/Invoke-RestMethod** mangles inline JSON and hangs on SSE endpoints. Use `Invoke-RestMethod` only on non-streaming endpoints (`/v1/models`, `/health`).

---

## 8. Current gaps / roadmap

| Gap | Notes |
|---|---|
| Usage reporting | Gateway sends a final usage chunk (`stream_options.include_usage`) and attaches `context` to the finish chunk. Not yet surfaced as `LanguageModelDataPart` (mime `usage`) for Copilot's context gauge. DeepSeek extension does this — copy the pattern. |
| Fail-loud 401 / unreachable | Implemented — returns a non-selectable error model in the picker instead of an empty list. |
| `.vscode/launch.json` | Add minimal `{ "type": "extensionHost", "request": "launch", "args": ["--extensionDevelopmentPath=${workspaceFolder}"] }` so F5 works out of the box. |
| Packaging | `npx @vscode/vsce package` → `.vsix` → GitHub Release asset. `.vscodeignore` in place. |
| `none` label | Dropdown label map: `none → 'Off'`. Already in place. |
| `provideTokenCount` refinement | Could adopt adaptive chars-per-token EMA from usage data (DeepSeek pattern). Low priority. |

---

## 9. Testing checklist (manual, dev host)

1. F5 → dev host opens. Gateway running on :3400.
2. `LLM Gateway: Set API Key` inside dev host.
3. Model picker → LLM Gateway group → models appear with correct names.
4. Thinking-effort icon (sliders) next to the selected gateway model in the chat input → dropdown lists the model's declared levels, `none` labeled "Off".
5. Send a message → response streams. Thinking models show collapsible reasoning blocks.
6. Change effort → gateway log shows `reasoning_effort` arriving; adapter translates it.
7. Agent mode task that triggers a tool call → tool roundtrip completes (exercises the ordering fix + flush-on-end).
8. Cancel mid-stream → request aborts (gateway cancels upstream).
9. Vision model + image attachment → image forwarded as data-URI.
