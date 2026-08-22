# LLM Gateway for Copilot Chat

Use your [LLM Gateway](https://github.com/herrbasan/LLM-Gateway) models directly in the GitHub Copilot Chat model picker — with a per-model **Thinking Effort** dropdown, collapsible reasoning display, tool calling, vision, and proper cancellation.

The extension is a thin proxy: your gateway manages the models, API keys, and provider quirks. This extension just makes them first-class citizens in Copilot Chat.

**Plain JavaScript. Zero dependencies. No build step.**

## Prerequisites

- VS Code 1.116 or newer
- GitHub Copilot Chat
- A running LLM Gateway (default: `http://localhost:3400`)

## Install

1. Download or build the `.vsix`:
   ```
   npx @vscode/vsce package
   ```
2. In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → pick the file.
3. `Ctrl+Shift+P` → **LLM Gateway: Set API Key** → paste your gateway access key (skip if your gateway has none).
4. Open Copilot Chat → model picker → scroll to the **LLM Gateway** group → pick a model.

If your gateway runs on a different host/port, set `llm-gateway-copilot.baseUrl` in Settings.

## Features

- **All gateway chat models in the picker** — discovered live from `GET /v1/models`. Use `llm-gateway-copilot.includeModels` / `excludeModels` to filter.
- **Thinking Effort dropdown** — the tune icon next to the model name in the chat input. Lists exactly the levels each model declares (`none` shows as "Off").
- **Thinking display** — reasoning streams into collapsible blocks, not plain text.
- **Tool calling / agent mode** — full Copilot agent stack (file edits, terminal, search) runs on your gateway models.
- **Vision** — image attachments are forwarded to vision-capable models.
- **Cancellation** — stopping a response aborts the upstream provider request at the gateway.

## Commands

| Command | What it does |
|---|---|
| `LLM Gateway: Set API Key` | Store the gateway access key (OS keychain via SecretStorage) |
| `LLM Gateway: Clear API Key` | Remove the stored key |
| `LLM Gateway: Refresh Models` | Re-fetch the model list |
| `LLM Gateway: Show Logs` | Open the extension's output channel |

## Settings

| Setting | Default | Description |
|---|---|---|
| `llm-gateway-copilot.baseUrl` | `http://localhost:3400` | Primary gateway base URL |
| `llm-gateway-copilot.baseUrlCandidates` | `[]` | Fallback URLs to try if `baseUrl` is unreachable (e.g. `http://192.168.0.100:3400`, `http://mcode.freeddns.org:3400`) |
| `llm-gateway-copilot.includeModels` | `[]` | Only expose these model IDs (empty = all chat models) |
| `llm-gateway-copilot.excludeModels` | `[]` | Hide these model IDs |

## Troubleshooting

- **Models missing / stale:** run `LLM Gateway: Refresh Models`, then reload the window. The picker caches model metadata aggressively.
- **No Thinking Effort dropdown:** the model doesn't declare `capabilities.thinkingLevels` in the gateway `config.json`, or the picker served cached metadata — reload the window.
- **401 errors in the log:** the stored key doesn't match the gateway's `accessKey`. Run Set API Key again.
- Check **LLM Gateway: Show Logs** for fetch errors and malformed stream lines.

## License

MIT
