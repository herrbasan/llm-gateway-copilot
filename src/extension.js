const vscode = require('vscode');
const createProvider = require('./provider.js');

async function activate(context) {
    const provider = createProvider(context);

    context.subscriptions.push(
        provider,
        vscode.commands.registerCommand('llm-gateway-copilot.setApiKey', () => provider.setApiKey()),
        vscode.commands.registerCommand('llm-gateway-copilot.setBaseUrl', () => provider.setBaseUrl()),
        vscode.commands.registerCommand('llm-gateway-copilot.clearApiKey', () => provider.clearApiKey()),
        vscode.commands.registerCommand('llm-gateway-copilot.refreshModels', () => provider.refresh()),
        vscode.commands.registerCommand('llm-gateway-copilot.showLogs', () => provider.showLogs()),
        vscode.lm.registerLanguageModelChatProvider('llm-gateway', provider),
    );

    // Copilot Chat can serve cached model info without configurationSchema.
    // Activate it first so the refresh reaches a live listener.
    const copilot = vscode.extensions.getExtension('github.copilot-chat');
    if (copilot) {
        await copilot.activate();
    }
    provider.refresh();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('llm-gateway-copilot')) {
                provider.refresh();
            }
        }),
    );
}

module.exports = { activate, deactivate() {} };
