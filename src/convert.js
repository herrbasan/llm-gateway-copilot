/**
 * Pure conversion: VS Code chat shapes <-> OpenAI wire format. No vscode
 * imports beyond the part constructors, no I/O, no state. Everything here
 * is directly testable by feeding arrays in and inspecting arrays out.
 */
const vscode = require('vscode');

function toRole(role) {
    if (role === vscode.LanguageModelChatMessageRole.User) return 'user';
    if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
    throw new Error(`toRole: unknown message role ${String(role)}`);
}

/** OpenAI messages from VS Code request messages. */
function toWireMessages(messages) {
    const out = [];
    for (const message of messages) {
        const role = toRole(message.role);
        let text = '';
        const images = [];
        let reasoning = '';
        const toolCalls = [];
        const toolResults = [];

        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                let resultText = '';
                for (const item of part.content) {
                    if (item instanceof vscode.LanguageModelTextPart) resultText += item.value;
                }
                toolResults.push({ callId: part.callId, content: resultText });
            } else if (isImagePart(part)) {
                const b64 = Buffer.from(part.data).toString('base64');
                images.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${b64}` } });
            } else if (isThinkingPart(part)) {
                reasoning += part.value;
            }
        }

        // Order matters: the assistant message carrying tool_calls must come
        // first, then one role:'tool' message per result. A message holding
        // only tool results emits no assistant/user shell at all.
        const pureResults = toolResults.length > 0 && !text && images.length === 0
            && !reasoning && toolCalls.length === 0;
        if (!pureResults) {
            const content = images.length > 0
                ? [{ type: 'text', text: text || ' ' }, ...images]
                : (text || null);
            const msg = { role, content };
            if (reasoning) msg.reasoning_content = reasoning;
            if (toolCalls.length > 0) msg.tool_calls = toolCalls;
            out.push(msg);
        }
        for (const tr of toolResults) {
            out.push({ role: 'tool', tool_call_id: tr.callId, content: tr.content });
        }
    }
    return out;
}

/** OpenAI tools from VS Code tool definitions. */
function toWireTools(tools) {
    if (!tools) return [];
    return tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
}

function isImagePart(part) {
    return part instanceof vscode.LanguageModelDataPart && typeof part.mimeType === 'string'
        && part.mimeType.startsWith('image/');
}

// LanguageModelThinkingPart is proposed — feature-detect instead of assuming.
function isThinkingPart(part) {
    const ctor = vscode.LanguageModelThinkingPart;
    return typeof ctor === 'function' && part instanceof ctor;
}

/** Report reasoning via ThinkingPart when the host provides it. */
function reportThinking(progress, text) {
    const ctor = vscode.LanguageModelThinkingPart;
    if (typeof ctor === 'function') {
        progress.report(new ctor(text));
    }
    // Without ThinkingPart the reasoning is dropped — interleaving it as plain
    // text would corrupt the answer.
}

module.exports = { toWireMessages, toWireTools, reportThinking };
