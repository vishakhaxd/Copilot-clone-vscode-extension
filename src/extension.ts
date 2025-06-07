import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';

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

    context.subscriptions.push(openChatCommand, clearChatCommand);
}

export function deactivate() {
    console.log('Cipher deactivated');
}
