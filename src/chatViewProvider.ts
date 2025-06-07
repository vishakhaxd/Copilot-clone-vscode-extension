import * as vscode from 'vscode';

interface ChatMessage {
    text: string;
    isUser: boolean;
    timestamp: string;
    id: string;
}

interface VSCodeContext {
    activeFile?: {
        path: string;
        language: string;
        content: string;
        cursorPosition?: {
            line: number;
            character: number;
        };
        selection?: {
            start: { line: number; character: number };
            end: { line: number; character: number };
            text: string;
        };
        totalLines?: number;
    };
    workspace?: {
        rootPath?: string;
        name?: string;
        folders?: string[];
    };
    terminal?: {
        activeTerminals: string[];
        terminalCount: number;
        note: string;
    };
    diagnostics?: {
        errors: string[];
        warnings: string[];
        infos: string[];
        totalCount: number;
    };
    openFiles?: {
        count: number;
        files: string[];
        activeFile?: string;
    };
    git?: {
        branch?: string;
        hasChanges?: boolean;
        changedFiles?: string[];
    };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'dsp-cipher.chat';
    private _view?: vscode.WebviewView;
    private _messages: ChatMessage[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            enableCommandUris: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            async (data) => {
                if (data.type === 'sendMessage') {
                    await this.handleUserMessage(data.message);
                }
            }
        );

        // Restore previous messages if any
        this.restoreMessages();
    }

    public clearChat() {
        this._messages = [];
        if (this._view) {
            this._view.webview.postMessage({
                type: 'clearChat'
            });
        }
    }

    private async handleUserMessage(message: string) {
        const userMessage: ChatMessage = {
            text: message,
            isUser: true,
            timestamp: new Date().toISOString(),
            id: this.generateId()
        };

        this._messages.push(userMessage);

        // Add user message to chat
        this._view?.webview.postMessage({
            type: 'addMessage',
            message: userMessage
        });

        // Show typing indicator
        this._view?.webview.postMessage({
            type: 'showTyping'
        });

        try {
            // Generate AI response
            const aiResponse = await this.generateAIResponse(message);
            const aiMessage: ChatMessage = {
                text: aiResponse,
                isUser: false,
                timestamp: new Date().toISOString(),
                id: this.generateId()
            };

            this._messages.push(aiMessage);

            // Hide typing indicator and add AI message
            this._view?.webview.postMessage({
                type: 'hideTyping'
            });

            this._view?.webview.postMessage({
                type: 'addMessage',
                message: aiMessage
            });

        } catch (error) {
            console.error('Error generating AI response:', error);
            
            this._view?.webview.postMessage({
                type: 'hideTyping'
            });

            const errorMessage: ChatMessage = {
                text: "Sorry, I encountered an error while processing your request. Please try again.",
                isUser: false,
                timestamp: new Date().toISOString(),
                id: this.generateId()
            };

            this._view?.webview.postMessage({
                type: 'addMessage',
                message: errorMessage
            });
        }
    }

    private async sendCurrentContext() {
        // This method can be used to send context to external AI service
    }

    private async gatherVSCodeContext(): Promise<VSCodeContext> {
        const context: VSCodeContext = {};

        try {
            // 1. Get active file content around cursor ±10 lines
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const document = activeEditor.document;
                const position = activeEditor.selection.active;
                
                // Get cursor position and file info
                context.activeFile = {
                    path: document.uri.fsPath,
                    language: document.languageId,
                    content: '',
                    totalLines: document.lineCount,
                    cursorPosition: {
                        line: position.line,
                        character: position.character
                    }
                };

                // Get content around cursor (±10 lines)
                const startLine = Math.max(0, position.line - 10);
                const endLine = Math.min(document.lineCount - 1, position.line + 10);
                
                let contextContent = '';
                for (let i = startLine; i <= endLine; i++) {
                    const lineText = document.lineAt(i).text;
                    const linePrefix = i === position.line ? '>>> ' : '    ';
                    contextContent += `${linePrefix}${i + 1}: ${lineText}\n`;
                }
                context.activeFile.content = contextContent;

                // Get selection if any
                if (!activeEditor.selection.isEmpty) {
                    const selection = activeEditor.selection;
                    context.activeFile.selection = {
                        start: { line: selection.start.line, character: selection.start.character },
                        end: { line: selection.end.line, character: selection.end.character },
                        text: document.getText(selection)
                    };
                }
            }

            // 2. Get workspace information
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                context.workspace = {
                    rootPath: workspaceFolders[0].uri.fsPath,
                    name: workspaceFolders[0].name,
                    folders: workspaceFolders.map(folder => folder.uri.fsPath)
                };
            }

            // 3. Get terminal information
            const terminals = vscode.window.terminals;
            context.terminal = {
                activeTerminals: terminals.map(terminal => terminal.name),
                terminalCount: terminals.length,
                note: 'VS Code API limitations: Command history and output require terminal integration'
            };

            // 4. Get diagnostics (errors/warnings/info) for all open files
            const allDiagnostics = vscode.languages.getDiagnostics();
            const errors: string[] = [];
            const warnings: string[] = [];
            const infos: string[] = [];
            
            allDiagnostics.forEach(([uri, diagnostics]) => {
                const fileName = uri.fsPath.split('/').pop() || uri.fsPath;
                diagnostics.forEach(diag => {
                    const message = `${fileName}:${diag.range.start.line + 1} - ${diag.message}`;
                    switch (diag.severity) {
                        case vscode.DiagnosticSeverity.Error:
                            errors.push(message);
                            break;
                        case vscode.DiagnosticSeverity.Warning:
                            warnings.push(message);
                            break;
                        case vscode.DiagnosticSeverity.Information:
                        case vscode.DiagnosticSeverity.Hint:
                            infos.push(message);
                            break;
                    }
                });
            });

            context.diagnostics = {
                errors,
                warnings,
                infos,
                totalCount: errors.length + warnings.length + infos.length
            };

            // 5. Get list of open files
            const openEditors = vscode.window.tabGroups.all
                .flatMap(group => group.tabs)
                .filter(tab => tab.input instanceof vscode.TabInputText)
                .map(tab => (tab.input as vscode.TabInputText).uri.fsPath);
            
            context.openFiles = {
                count: openEditors.length,
                files: openEditors,
                activeFile: activeEditor?.document.uri.fsPath
            };

            // 6. Get Git information (if available)
            try {
                const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
                if (gitExtension && workspaceFolders) {
                    const repo = gitExtension.getRepository(workspaceFolders[0].uri);
                    if (repo) {
                        context.git = {
                            branch: repo.state.HEAD?.name,
                            hasChanges: repo.state.workingTreeChanges.length > 0 || repo.state.indexChanges.length > 0,
                            changedFiles: [
                                ...repo.state.workingTreeChanges.map((change: any) => `Modified: ${change.uri.fsPath}`),
                                ...repo.state.indexChanges.map((change: any) => `Staged: ${change.uri.fsPath}`)
                            ]
                        };
                    }
                }
            } catch (gitError) {
                // Git info is optional, continue without it
                context.git = { branch: 'unknown', hasChanges: false };
            }

        } catch (error) {
            console.error('Error gathering VS Code context:', error);
        }

        return context;
    }

    private async generateAIResponse(userMessage: string): Promise<string> {
        // Gather context before generating response
        const context = await this.gatherVSCodeContext();
        
        // Enhanced response generation with context
        const responses = this.getContextualResponses(userMessage, context);
        
        // Simulate AI thinking time
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
        
        return responses[Math.floor(Math.random() * responses.length)];
    }

    private getContextualResponses(message: string, context?: VSCodeContext): string[] {
        const lowerMessage = message.toLowerCase();
        
        // Build enhanced context information
        let contextInfo = '';
        
        if (context?.activeFile) {
            const file = context.activeFile;
            contextInfo += `\n\n📁 **Current Context:**`;
            contextInfo += `\n• File: ${file.path.split('/').pop()} (${file.language})`;
            contextInfo += `\n• Line ${file.cursorPosition?.line! + 1}/${file.totalLines}`;
            
            if (file.selection) {
                contextInfo += `\n• Selected: "${file.selection.text.substring(0, 50)}${file.selection.text.length > 50 ? '...' : ''}"`;
            }
        }
        
        if (context?.workspace) {
            contextInfo += `\n• Workspace: ${context.workspace.name}`;
        }
        
        if (context?.diagnostics && context.diagnostics.totalCount > 0) {
            contextInfo += `\n• Issues: ${context.diagnostics.errors.length} errors, ${context.diagnostics.warnings.length} warnings`;
        }
        
        if (context?.openFiles && context.openFiles.count > 1) {
            contextInfo += `\n• Open files: ${context.openFiles.count}`;
        }
        
        if (context?.git?.branch) {
            contextInfo += `\n• Git branch: ${context.git.branch}`;
            if (context.git.hasChanges) {
                contextInfo += ` (${context.git.changedFiles?.length || 0} changes)`;
            }
        }
        
        // Context-aware responses based on current state
        if (context?.diagnostics?.errors && context.diagnostics.errors.length > 0) {
            return [
                `I notice you have ${context.diagnostics.errors.length} error(s) in your code. Let me help you fix them!${contextInfo}`,
                `There are some errors to address. Would you like me to help debug them?${contextInfo}`,
                `I see compilation errors. Let's tackle them one by one.${contextInfo}`
            ];
        }
        
        if (lowerMessage.includes('algorithm') || lowerMessage.includes('complexity')) {
            return [
                `Let me help you analyze the algorithm complexity. For most problems, we want to aim for O(n) or O(n log n) solutions.${contextInfo}`,
                `Great question about algorithms! Let's break down the approach step by step.${contextInfo}`,
                `When choosing an algorithm, consider the time-space tradeoff. What constraints are you working with?${contextInfo}`
            ];
        }
        
        if (lowerMessage.includes('leetcode') || lowerMessage.includes('problem')) {
            return [
                `LeetCode problems often have multiple solutions. Let's start with a brute force approach and then optimize.${contextInfo}`,
                `For this type of problem, I'd recommend drawing out a few examples first. What patterns do you notice?${contextInfo}`,
                `This looks like a classic problem type. Have you considered using a two-pointer technique or sliding window?${contextInfo}`
            ];
        }
        
        if (lowerMessage.includes('data structure')) {
            return [
                `Choosing the right data structure is crucial! What operations do you need to perform most frequently?${contextInfo}`,
                `Let's think about this: arrays for random access, linked lists for insertions, hash maps for lookups.${contextInfo}`,
                `The best data structure depends on your use case. What are the main operations you need?${contextInfo}`
            ];
        }
        
        if (lowerMessage.includes('debug') || lowerMessage.includes('error')) {
            const errorContext = (context?.diagnostics?.errors && context.diagnostics.errors.length > 0)
                ? `\n\n🐛 **Current Errors:**\n${context.diagnostics.errors.slice(0, 3).map(err => `• ${err}`).join('\n')}${context.diagnostics.errors.length > 3 ? '\n• ...' : ''}` 
                : '';
            
            return [
                `Debugging can be tricky! Let's start by identifying where the issue might be occurring.${contextInfo}${errorContext}`,
                `Common debugging strategies: check edge cases, trace through with small examples, verify your assumptions.${contextInfo}${errorContext}`,
                `What specific error are you encountering? Let's tackle it step by step.${contextInfo}${errorContext}`
            ];
        }
        
        if (lowerMessage.includes('optimize') || lowerMessage.includes('improve')) {
            return [
                `Optimization is key! Let's look at the current time and space complexity and see where we can improve.${contextInfo}`,
                `There are usually multiple ways to optimize. Are you looking to improve time complexity, space complexity, or code readability?${contextInfo}`,
                `Great thinking about optimization! Let's analyze the bottlenecks in your current approach.${contextInfo}`
            ];
        }
        
        // Context-aware default responses
        if (context?.activeFile) {
            const language = context.activeFile.language;
            const fileName = context.activeFile.path.split('/').pop();
            
            return [
                `I can see you're working on **${fileName}** (${language}). What specific challenge are you facing?${contextInfo}`,
                `Looking at your current ${language} file, what would you like help with?${contextInfo}`,
                `I'm here to help with your ${language} code. What's the problem you're trying to solve?${contextInfo}`
            ];
        }
        
        // Default responses
        return [
            "I'm here to help with your coding challenges! What specific problem are you working on?",
            "Let's tackle this together! Can you share more details about what you're trying to solve?",
            "Coding problems can be complex, but we can break them down. What's the main challenge you're facing?",
            "I love helping with algorithms and data structures! What would you like to explore today?",
            "Every coding problem has a solution. Let's think through this step by step."
        ];
    }

    private restoreMessages() {
        // Send all previous messages to the webview
        this._messages.forEach(message => {
            this._view?.webview.postMessage({
                type: 'addMessage',
                message: message
            });
        });
    }

    private generateId(): string {
        return Math.random().toString(36).substr(2, 9);
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Generate a nonce for the CSP
        const nonce = this.getNonce();
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Cipher</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .chat-container {
            display: flex;
            flex-direction: column;
            height: 100%;
            overflow: hidden;
        }

        .messages-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            scroll-behavior: smooth;
        }

        .message {
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
        }

        .message.user {
            align-items: flex-end;
        }

        .message.assistant {
            align-items: flex-start;
        }

        .message-bubble {
            max-width: 80%;
            padding: 12px 16px;
            border-radius: 18px;
            word-wrap: break-word;
            white-space: pre-wrap;
            line-height: 1.4;
        }

        .message.user .message-bubble {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .message.assistant .message-bubble {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
        }

        .typing-indicator {
            display: none;
            margin-bottom: 16px;
            align-items: flex-start;
        }

        .typing-bubble {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 18px;
            padding: 12px 16px;
            color: var(--vscode-descriptionForeground);
        }

        .typing-dots {
            display: inline-flex;
            align-items: center;
        }

        .typing-dots span {
            height: 6px;
            width: 6px;
            background-color: var(--vscode-descriptionForeground);
            border-radius: 50%;
            display: inline-block;
            margin: 0 1px;
            animation: typing 1.4s infinite ease-in-out both;
        }

        .typing-dots span:nth-child(1) { animation-delay: -0.32s; }
        .typing-dots span:nth-child(2) { animation-delay: -0.16s; }
        .typing-dots span:nth-child(3) { animation-delay: 0s; }

        @keyframes typing {
            0%, 80%, 100% {
                transform: scale(0.8);
                opacity: 0.5;
            }
            40% {
                transform: scale(1);
                opacity: 1;
            }
        }

        .input-container {
            padding: 16px;
            background-color: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }

        .input-row {
            display: flex;
            gap: 8px;
            align-items: flex-end;
        }

        .message-input {
            flex: 1;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 20px;
            padding: 12px 16px;
            font-family: var(--vscode-font-family);
            font-size: 14px;
            resize: none;
            outline: none;
            min-height: 20px;
            max-height: 120px;
            overflow-y: auto;
            line-height: 1.4;
        }

        .message-input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .message-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        .send-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 50%;
            width: 44px;
            height: 44px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            transition: background-color 0.2s;
            flex-shrink: 0;
        }

        .send-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .send-button:disabled {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: not-allowed;
        }

        .welcome-message {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }

        .welcome-logo {
            width: 80px;
            height: 80px;
            margin-bottom: 24px;
            background-color: var(--vscode-sideBar-background);
            border: 2px solid var(--vscode-panel-border);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            color: var(--vscode-foreground);
        }

        .welcome-title {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 12px;
            color: var(--vscode-foreground);
        }

        .welcome-subtitle {
            font-size: 14px;
            line-height: 1.5;
            max-width: 400px;
            opacity: 0.8;
        }

        /* Scrollbar styling */
        .messages-container::-webkit-scrollbar {
            width: 6px;
        }

        .messages-container::-webkit-scrollbar-track {
            background: transparent;
        }

        .messages-container::-webkit-scrollbar-thumb {
            background-color: var(--vscode-scrollbarSlider-background);
            border-radius: 3px;
        }

        .messages-container::-webkit-scrollbar-thumb:hover {
            background-color: var(--vscode-scrollbarSlider-hoverBackground);
        }
    </style>
</head>
<body>
    <div class="chat-container">
        <div class="messages-container" id="messagesContainer">
            <div class="welcome-message">
                <div class="welcome-logo">{  }</div>
                <div class="welcome-title">Ask Cipher</div>
                <div class="welcome-subtitle">
                    Your AI assistant for algorithms, data structures, and coding challenges.
                </div>
            </div>
        </div>

        <div class="typing-indicator" id="typingIndicator">
            <div class="typing-bubble">
                <div class="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>
        </div>

        <div class="input-container">
            <div class="input-row">
                <textarea 
                    id="messageInput" 
                    class="message-input" 
                    placeholder="Ask Cipher..."
                    rows="1"
                ></textarea>
                <button id="sendButton" class="send-button">
                    ➤
                </button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const messagesContainer = document.getElementById('messagesContainer');
        const typingIndicator = document.getElementById('typingIndicator');

        // Initialize send button state
        sendButton.disabled = true;

        // Auto-resize textarea and handle button state
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            
            // Enable/disable send button based on content
            const hasContent = this.value.trim().length > 0;
            sendButton.disabled = !hasContent;
        });

        // Send message on Enter (but allow Shift+Enter for new lines)
        messageInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Add click event listener to send button
        sendButton.addEventListener('click', function() {
            sendMessage();
        });

        function sendMessage() {
            const message = messageInput.value.trim();
            if (!message) return;
            
            // Clear input and reset button state
            messageInput.value = '';
            messageInput.style.height = 'auto';
            sendButton.disabled = true;

            // Send to extension
            vscode.postMessage({
                type: 'sendMessage',
                message: message
            });
        }

        function addMessage(message) {
            // Remove welcome message if it exists
            const welcomeMessage = document.querySelector('.welcome-message');
            if (welcomeMessage) {
                welcomeMessage.remove();
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${message.isUser ? 'user' : 'assistant'}\`;
            
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble';
            bubble.textContent = message.text;
            
            messageDiv.appendChild(bubble);
            messagesContainer.appendChild(messageDiv);
            
            // Scroll to bottom
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function showTyping() {
            typingIndicator.style.display = 'flex';
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function hideTyping() {
            typingIndicator.style.display = 'none';
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'addMessage':
                    addMessage(message.message);
                    break;
                case 'showTyping':
                    showTyping();
                    break;
                case 'hideTyping':
                    hideTyping();
                    break;
                case 'clearChat':
                    messagesContainer.innerHTML = \`
            <div class="welcome-message">
                <div class="welcome-logo">{  }</div>
                <div class="welcome-title">Ask Cipher</div>
                <div class="welcome-subtitle">
                    Your AI assistant for algorithms, data structures, and coding challenges.
                </div>
            </div>
                    \`;
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
