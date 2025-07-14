import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { exec } from 'child_process';
import { getWorkspaceInfo } from './util';

export function activate(context: vscode.ExtensionContext) {
    // Set context for when chat is enabled
    vscode.commands.executeCommand('setContext', 'dsp-cipher.chatEnabled', true);

    // Register chat view provider
    const chatProvider = new ChatViewProvider(context.extensionUri);
    
    const webviewDisposable = vscode.window.registerWebviewViewProvider('dsp-cipher.chat', chatProvider);    
    context.subscriptions.push(webviewDisposable);

    // Register command to open chat
    const openChatCommand = vscode.commands.registerCommand('dsp-cipher.openChat', () => {
        vscode.commands.executeCommand('dsp-cipher.chat.focus');
    });

    // Register command to clear chat
    const clearChatCommand = vscode.commands.registerCommand('dsp-cipher.clearChat', () => {
        chatProvider.clearChat();
        vscode.window.showInformationMessage('Chat history cleared!');
    });

    // Register command to run code
    const runCodeCommand = vscode.commands.registerCommand('dsp-cipher.run', () => {
        const message = vscode.window.setStatusBarMessage('$(sync~spin) Runnind codebase ...');
        try {   
                const workspaceInfo = getWorkspaceInfo();
                const cmd = `/bin/req ${workspaceInfo?.name} run`;
                exec(cmd, (error, stdout, stderr) => {
                    if (error) {
                        vscode.window.showErrorMessage(`Run Error`);
                        return;
                    }
                    if (stderr) {
                        return;
                    }
                });
            } catch (err) {
                vscode.window.showErrorMessage(`Run failed try again`);
            }
        // extra timeout to compensate for dspcoder-panel
        setTimeout(() => {
            message.dispose();
        }, 3000);
    });

    // Register command to submit code
    const submitCodeCommand = vscode.commands.registerCommand('dsp-cipher.submit', () => {
        const message = vscode.window.setStatusBarMessage('$(sync~spin) Submitting codebase ...');
        try {   
                const workspaceInfo = getWorkspaceInfo();
                const cmd = `/bin/req ${workspaceInfo?.name} submit`;
                exec(cmd, (error, stdout, stderr) => {
                    if (error) {
                        vscode.window.showErrorMessage(`submit Error`);
                        return;
                    }
                    if (stderr) {
                        return;
                    }
                });
            } catch (err) {
                vscode.window.showErrorMessage(`submit failed try again`);
            }
        // extra timeout to compensate for dspcoder-panel
        setTimeout(() => {
            message.dispose();
        }, 3000);
    });

    context.subscriptions.push(openChatCommand, clearChatCommand, runCodeCommand, submitCodeCommand);
}

export function deactivate() {
    console.log('Cipher deactivated');
}
