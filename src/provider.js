/**
 * Gateway state + streaming. Owns the api key, model cache, and the SSE
 * request loop; reports progress through the host-supplied progress object.
 * Exposed as closures, not a class — the only state is what's closed over.
 */
const vscode = require('vscode');
const { toWireMessages, toWireTools, reportThinking } = require('./convert.js');

const API_KEY_SECRET = 'llm-gateway-copilot.apiKey';
const log = vscode.window.createOutputChannel('LLM Gateway Copilot', { log: true });

function baseUrl() {
    const raw = vscode.workspace.getConfiguration('llm-gateway-copilot').get('baseUrl', 'http://localhost:3400');
    return raw.replace(/\/+$/, '');
}

function authHeaders(key) {
    return key ? { Authorization: `Bearer ${key}` } : {};
}

async function gatewayFetch(path, key, init) {
    const res = await fetch(`${baseUrl()}${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), ...authHeaders(key) },
    });
    if (!res.ok) {
        throw new Error(`${init?.method ?? 'GET'} ${path} failed (${res.status}): ${await errorBody(res)}`);
    }
    return res;
}

async function errorBody(res) {
    try {
        return (await res.text()).slice(0, 500);
    } catch {
        return '<no body>';
    }
}

async function ping() {
    try {
        const res = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Parse an SSE body into async-iterable JSON chunks. Malformed lines are
 * logged and skipped — one corrupt line must not kill a response stream.
 */
async function* sseChunks(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') return;
                try {
                    yield JSON.parse(data);
                } catch {
                    log.warn(`Dropping malformed SSE line: ${data.slice(0, 200)}`);
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

function estimateTokens(text) {
    if (typeof text === 'string') {
        return Math.max(1, Math.ceil(text.length / 4));
    }
    let chars = 0;
    for (const part of text?.content ?? []) {
        if (part instanceof vscode.LanguageModelTextPart) {
            chars += part.value.length;
        } else if (part instanceof vscode.LanguageModelDataPart) {
            chars += 1020;
        }
    }
    return Math.max(1, Math.ceil(chars / 4));
}

module.exports = function createProvider(context) {
    const onChange = new vscode.EventEmitter();
    let apiKey;
    let models = [];

    async function loadKey() {
        const stored = await context.secrets.get(API_KEY_SECRET);
        apiKey = stored || undefined;
    }

    function refresh() {
        onChange.fire();
    }

    async function setApiKey() {
        const entered = await vscode.window.showInputBox({
            prompt: 'LLM Gateway access key (Bearer). Leave empty if the gateway requires none.',
            password: true,
            ignoreFocusOut: true,
        });
        if (entered === undefined) return;
        await context.secrets.store(API_KEY_SECRET, entered.trim());
        await loadKey();
        refresh();
    }

    async function clearApiKey() {
        await context.secrets.delete(API_KEY_SECRET);
        apiKey = undefined;
        refresh();
    }

    async function provideLanguageModelChatInformation() {
        const reachable = await ping();
        try {
            const res = await gatewayFetch('/v1/models?type=chat', apiKey);
            const data = await res.json();
            // Live shape: { object: 'list', data: [...] } — the type filter already
            // narrowed it server-side. Array fallback for unfiltered local shapes.
            const all = Array.isArray(data) ? data : (data.data ?? data.chat ?? []);
            const cfg = vscode.workspace.getConfiguration('llm-gateway-copilot');
            const include = cfg.get('includeModels', []);
            const exclude = new Set(cfg.get('excludeModels', []));
            models = include.length > 0
                ? all.filter((m) => include.includes(m.id))
                : all.filter((m) => !exclude.has(m.id));
        } catch (err) {
            log.warn(`Model fetch failed: ${String(err)}`);
            models = [];
        }
        return models.map((m) => toChatInfo(m, reachable));
    }

    function toChatInfo(m, reachable) {
        const levels = m.capabilities?.thinkingLevels;
        const info = {
            id: m.id,
            name: m.prettyName || m.id,
            family: 'llm-gateway',
            version: '1.0.0',
            maxInputTokens: m.maxInputTokens ?? m.contextWindow ?? 128000,
            maxOutputTokens: m.maxOutputTokens ?? m.capabilities?.maxOutputTokens ?? 8192,
            isBYOK: true,
            isUserSelectable: true,
            capabilities: {
                toolCalling: Boolean(m.capabilities?.toolCalling ?? m.capabilities?.tools ?? true),
                imageInput: Boolean(m.capabilities?.vision),
            },
            tooltip: `via LLM Gateway — ${m.owned_by}`,
        };
        if (!apiKey) {
            info.detail = 'Run "LLM Gateway: Set API Key"';
            info.statusIcon = new vscode.ThemeIcon('warning');
        } else if (!reachable) {
            info.detail = 'Gateway unreachable';
            info.statusIcon = new vscode.ThemeIcon('debug-disconnect');
        }
        if (Array.isArray(levels) && levels.length > 0) {
            const labels = { none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };
            info.configurationSchema = {
                type: 'object',
                properties: {
                    reasoningEffort: {
                        type: 'string',
                        title: 'Thinking Effort',
                        enum: levels,
                        enumItemLabels: levels.map((l) => labels[l] ?? l),
                        default: levels.includes('high') ? 'high' : levels[levels.length - 1],
                        description: 'Thinking effort',
                        group: 'navigation',
                    },
                },
            };
        }
        return info;
    }

    async function provideLanguageModelChatResponse(modelInfo, messages, options, progress, token) {
        const model = models.find((m) => m.id === modelInfo.id);
        if (!model) {
            throw new Error(`Model "${modelInfo.id}" not currently known — run "LLM Gateway: Refresh Models"`);
        }

        const levels = model.capabilities?.thinkingLevels;
        const rawEffort = options.modelConfiguration?.reasoningEffort;
        const effort = Array.isArray(levels) && typeof rawEffort === 'string' && levels.includes(rawEffort)
            ? rawEffort
            : undefined;

        const body = {
            model: model.id,
            messages: toWireMessages(messages),
            stream_options: { include_usage: true },
        };
        if (effort) body.reasoning_effort = effort;
        const tools = toWireTools(options.tools);
        if (tools.length > 0) body.tools = tools;

        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        // Tool-call fragments stream incrementally — accumulate per index.
        const toolAcc = new Map();
        const flushTools = () => {
            for (const acc of toolAcc.values()) {
                progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, safeParse(acc.args)));
            }
            toolAcc.clear();
        };

        try {
            const res = await gatewayFetch('/v1/chat/completions', apiKey, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, stream: true }),
                signal: controller.signal,
            });
            for await (const chunk of sseChunks(res.body)) {
                if (token.isCancellationRequested) return;
                for (const choice of chunk.choices ?? []) {
                    const delta = choice.delta ?? choice.message;
                    if (delta?.reasoning_content) {
                        reportThinking(progress, delta.reasoning_content);
                    }
                    if (delta?.content) {
                        progress.report(new vscode.LanguageModelTextPart(delta.content));
                    }
                    if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const acc = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
                            if (tc.id) acc.id = tc.id;
                            if (tc.function?.name) acc.name = tc.function.name;
                            if (tc.function?.arguments) acc.args += tc.function.arguments;
                            toolAcc.set(tc.index, acc);
                        }
                    }
                    if (choice.finish_reason === 'tool_calls') {
                        flushTools();
                    }
                }
            }
        } finally {
            // Stream ended without explicit tool_calls finish — flush anyway
            // so an in-progress tool flow does not dead-end.
            flushTools();
        }
    }

    async function provideTokenCount(_modelInfo, text) {
        return estimateTokens(text);
    }

    void loadKey().then(() => refresh());

    return {
        onDidChangeLanguageModelChatInformation: onChange.event,
        provideLanguageModelChatInformation,
        provideLanguageModelChatResponse,
        provideTokenCount,
        refresh,
        setApiKey,
        clearApiKey,
        showLogs: () => log.show(),
        dispose: () => onChange.dispose(),
    };
};

function safeParse(json) {
    try {
        const parsed = JSON.parse(json);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}
