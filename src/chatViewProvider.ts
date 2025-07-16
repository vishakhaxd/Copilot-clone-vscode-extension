import * as vscode from 'vscode';
import * as WebSocket from 'ws';

interface ChatMessage {
    text: string;
    isUser: boolean;
    timestamp: string;
    id: string;
    isBackendInitiated?: boolean; // For backend-initiated messages
}

interface VSCodeContext {
    activeFile?: {
        path: string;
        language: string;
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
    git?: {
        branch?: string;
        hasChanges?: boolean;
        changedFiles?: Array<{
            file: string;
            status: string;
        }>;
        stagedFiles?: Array<{
            file: string;
            status: string;
        }>;
        commits?: Array<{
            hash: string;
            message: string;
            author: string;
            date: string;
        }>;
        remotes?: Array<{
            name: string;
            url: string;
        }>;
        ahead?: number;
        behind?: number;
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
    debugging?: {
        isDebugging: boolean;
        breakpoints?: Array<{
            file: string;
            line: number;
            condition?: string;
        }>;
        watchExpressions?: Array<{
            expression: string;
            value?: string;
        }>;
        callStack?: string[];
        currentFrame?: {
            file: string;
            line: number;
            function: string;
        };
    };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'dsp-cipher.chat';
    private _view?: vscode.WebviewView;
    private static _messages: ChatMessage[] = []; // Make it static to persist across instances
    private static _instances: ChatViewProvider[] = []; // Track all instances
    private _currentModeResolver?: (mode: string) => void;
    
    // WebSocket properties
    private _webSocket?: WebSocket;
    private _isConnected = false;
    private _clientId: string;
    private _reconnectTimeout?: NodeJS.Timeout;
    
    // Status bar message tracking for submissions
    private _activeStatusMessages: Map<string, vscode.Disposable> = new Map();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _activityProvider?: any // ActivityViewProvider
    ) {
        // Add this instance to the static list
        ChatViewProvider._instances.push(this);
        this._clientId = `vscode_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        // Initialize WebSocket when extension loads
        this.initializeWebSocket();
    }

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
                    await this.handleUserMessage(data.message, data.mode);
                } else if (data.type === 'currentModeResponse') {
                    // Handle the current mode response for clear chat functionality
                    this._currentModeResolver?.(data.mode);
                    this._currentModeResolver = undefined;
                } else if (data.type === 'requestMessages') {
                    // Send current messages when requested
                    this.restoreMessages();
                }
            }
        );

        // Clean up when webview is disposed
        webviewView.onDidDispose(() => {
            const index = ChatViewProvider._instances.indexOf(this);
            if (index > -1) {
                ChatViewProvider._instances.splice(index, 1);
            }
        });

        // Restore previous messages if any
        setTimeout(() => {
            this.restoreMessages();
        }, 100);
    }

    private static _updateAllViews(type: string, data: any) {
        // Update all active instances
        ChatViewProvider._instances.forEach(instance => {
            if (instance._view) {
                instance._view.webview.postMessage({
                    type: type,
                    ...data
                });
            }
        });
    }

    private async getCurrentModeFromWebview(): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this._view) {
                reject(new Error('Webview not available'));
                return;
            }

            // Store the resolver for when the webview responds
            this._currentModeResolver = resolve;

            // Request current mode from webview
            this._view.webview.postMessage({
                type: 'requestCurrentMode'
            });

            // Set timeout to avoid hanging
            setTimeout(() => {
                if (this._currentModeResolver) {
                    this._currentModeResolver = undefined;
                    reject(new Error('Timeout waiting for mode response'));
                }
            }, 1000);
        });
    }

    public async clearChat() {
        // Clear static messages first
        ChatViewProvider._messages = [];
        
        // Clear the chat UI for all instances
        ChatViewProvider._updateAllViews('clearChat', {});
        
        // Get workspace information for the API call
        let question: string | undefined;
        let path: string | undefined;
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            path = workspaceFolders[0].uri.fsPath;
            question = workspaceFolders[0].name;
        }
        
        // Get current mode from webview and clear checkpoints with actual mode
        try {
            const currentMode = await this.getCurrentModeFromWebview();
            this.clearCheckpoints(question, path, currentMode).catch(() => {
                // Silently handle errors - chat was cleared locally
            });
        } catch (error) {
            // If we can't get the mode, fallback to 'ask' mode
            this.clearCheckpoints(question, path, 'ask').catch(() => {
                // Silently handle errors - chat was cleared locally
            });
        }
    }

    private async handleUserMessage(message: string, mode: string = 'ask') {
        const userMessage: ChatMessage = {
            text: message,
            isUser: true,
            timestamp: new Date().toISOString(),
            id: this.generateId()
        };

        ChatViewProvider._messages.push(userMessage);

        // Add user message to chat - update all instances
        ChatViewProvider._updateAllViews('addMessage', { message: userMessage });

        // Show typing indicator
        ChatViewProvider._updateAllViews('showTyping', {});

        try {
            // Gather context first
            const context = await this.gatherVSCodeContext();
            const workspaceFolders = vscode.workspace.workspaceFolders;
            let question: string | undefined;
            let path: string | undefined;
            
            if (workspaceFolders && workspaceFolders.length > 0) {
                path = workspaceFolders[0].uri.fsPath;
                question = workspaceFolders[0].name;
            }

            // Send via WebSocket only
            const sent = this.sendWebSocketMessage({
                type: 'chat_message',
                message: message,
                mode: mode,
                context: context,
                clientId: this._clientId,
                question: question,
                path: path
            });

            if (!sent) {
                // No fallback - show error if WebSocket is not available
                ChatViewProvider._updateAllViews('hideTyping', {});

                const errorMessage: ChatMessage = {
                    text: "I am currently unable to process your request. Please refresh the chat or try again.",
                    isUser: false,
                    timestamp: new Date().toISOString(),
                    id: this.generateId()
                };

                ChatViewProvider._messages.push(errorMessage);
                ChatViewProvider._updateAllViews('addMessage', { message: errorMessage });
                return;
            }
            // Response will come via WebSocket onmessage handler

        } catch (error) {
            console.error('Error generating AI response:', error);
            
            ChatViewProvider._updateAllViews('hideTyping', {});

            const errorMessage: ChatMessage = {
                text: "Sorry, I encountered an error while processing your request. Please try again.",
                isUser: false,
                timestamp: new Date().toISOString(),
                id: this.generateId()
            };

            ChatViewProvider._messages.push(errorMessage);
            ChatViewProvider._updateAllViews('addMessage', { message: errorMessage });
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
                    totalLines: document.lineCount,
                    cursorPosition: {
                        line: position.line,
                        character: position.character
                    }
                };

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

            // 2. Get workspace information for Git operations
            const workspaceFolders = vscode.workspace.workspaceFolders;

            // 3. Get comprehensive Git information
            try {
                const gitExtension = vscode.extensions.getExtension('vscode.git');
                console.log('Git extension found:', !!gitExtension, 'Active:', gitExtension?.isActive);
                let gitApi = null;
                
                if (gitExtension) {
                    if (!gitExtension.isActive) {
                        console.log('Activating git extension...');
                        await gitExtension.activate();
                    }
                    gitApi = gitExtension.exports?.getAPI(1);
                    console.log('Git API obtained:', !!gitApi, 'Repositories:', gitApi?.repositories?.length);
                }
                
                if (gitApi && workspaceFolders) {
                    const repo = gitApi.repositories.find((r: any) => 
                        workspaceFolders.some(folder => 
                            r.rootUri.fsPath === folder.uri.fsPath
                        )
                    );
                    
                    if (repo) {
                        const state = repo.state;
                        context.git = {
                            branch: state.HEAD?.name || 'detached',
                            hasChanges: state.workingTreeChanges.length > 0 || state.indexChanges.length > 0
                        };

                        // Get working tree changes (unstaged)
                        context.git.changedFiles = state.workingTreeChanges.map((change: any) => ({
                            file: change.uri.fsPath.replace(workspaceFolders[0].uri.fsPath, '').replace(/^\//, ''),
                            status: this.getGitStatusString(change.status)
                        }));

                        // Get staged changes
                        context.git.stagedFiles = state.indexChanges.map((change: any) => ({
                            file: change.uri.fsPath.replace(workspaceFolders[0].uri.fsPath, '').replace(/^\//, ''),
                            status: this.getGitStatusString(change.status)
                        }));

                        // Get recent commits (if available)
                        try {
                            if (state.HEAD?.commit) {
                                const headCommit = state.HEAD.commit;
                                context.git.commits = [{
                                    hash: headCommit.substring(0, 8),
                                    message: state.HEAD.name ? `HEAD (${state.HEAD.name})` : 'HEAD',
                                    author: 'Current user',
                                    date: new Date().toISOString()
                                }];
                            } else {
                                context.git.commits = [];
                            }
                        } catch (commitError) {
                            context.git.commits = [];
                        }

                        // Get remotes
                        try {
                            context.git.remotes = state.remotes?.map((remote: any) => ({
                                name: remote.name,
                                url: remote.fetchUrl || remote.pushUrl || 'unknown'
                            })) || [];
                        } catch (remoteError) {
                            context.git.remotes = [];
                        }

                        // Get ahead/behind status
                        try {
                            const head = state.HEAD;
                            if (head?.ahead !== undefined) {
                                context.git.ahead = head.ahead;
                            }
                            if (head?.behind !== undefined) {
                                context.git.behind = head.behind;
                            }
                        } catch (aheadBehindError) {
                            // Ahead/behind info not available
                        }
                    } else {
                        // Repository found but no repo object
                        context.git = { 
                            branch: 'Repository not initialized in Git extension', 
                            hasChanges: false,
                            changedFiles: [],
                            stagedFiles: [],
                            commits: [],
                            remotes: []
                        };
                    }
                } else {
                    // Git extension not available or not activated
                    context.git = { 
                        branch: 'Git extension not available', 
                        hasChanges: false,
                        changedFiles: [],
                        stagedFiles: [],
                        commits: [],
                        remotes: []
                    };
                }
            } catch (gitError) {
                console.error('Git context error:', gitError);
                // Git info is optional, continue without it
                const errorMessage = gitError instanceof Error ? gitError.message : 'Unknown error';
                context.git = { 
                    branch: `Git error: ${errorMessage}`, 
                    hasChanges: false,
                    changedFiles: [],
                    stagedFiles: [],
                    commits: [],
                    remotes: []
                };
            }

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

            // 6. Get debugging information
            try {
                const debugSession = vscode.debug.activeDebugSession;
                context.debugging = {
                    isDebugging: !!debugSession
                };

                if (debugSession) {
                    // Get breakpoints
                    const breakpoints = vscode.debug.breakpoints;
                    context.debugging.breakpoints = breakpoints
                        .filter(bp => bp instanceof vscode.SourceBreakpoint)
                        .map(bp => {
                            const sourceBp = bp as vscode.SourceBreakpoint;
                            return {
                                file: sourceBp.location.uri.fsPath,
                                line: sourceBp.location.range.start.line + 1,
                                condition: sourceBp.condition
                            };
                        });

                    // Note: VS Code API doesn't provide direct access to watch expressions or call stack
                    // These would require debug adapter protocol implementation
                    context.debugging.watchExpressions = [];
                    context.debugging.callStack = ["Call stack not accessible via VS Code extension API"];
                }
            } catch (debugError) {
                context.debugging = { isDebugging: false };
            }

        } catch (error) {
            console.error('Error gathering VS Code context:', error);
        }

        return context;
    }

    private restoreMessages() {
        // Send all previous messages to the webview
        ChatViewProvider._messages.forEach((message: ChatMessage) => {
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; img-src data: https:; connect-src *;">
    <title>Cipher</title>
    <!-- Highlight.js for syntax highlighting -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-sideBar-background);
            color: var(--vscode-foreground);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Global focus outline removal - preserve borders */
        *, *:focus, *:active, *:hover {
            outline: none !important;
            box-shadow: none !important;
        }

        /* Specifically target form elements */
        input, textarea, select, button {
            outline: none !important;
            box-shadow: none !important;
            border: none !important;
        }

        input:focus, textarea:focus, select:focus, button:focus {
            outline: none !important;
            box-shadow: none !important;
            border: none !important;
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
            background-color: var(--vscode-sideBar-background);
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
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-input-border);
            white-space: normal;
            max-width: 90%;
            box-shadow: 0 2px 8px var(--vscode-widget-shadow);
        }

        /* Markdown Styles - GitHub Copilot inspired */
        .message-bubble h1, .message-bubble h2, .message-bubble h3, .message-bubble h4, .message-bubble h5, .message-bubble h6 {
            margin: 16px 0 8px 0;
            color: var(--vscode-foreground);
            font-weight: 600;
            line-height: 1.3;
        }

        .message-bubble h1:first-child, .message-bubble h2:first-child, .message-bubble h3:first-child, 
        .message-bubble h4:first-child, .message-bubble h5:first-child, .message-bubble h6:first-child {
            margin-top: 0;
        }

        .message-bubble h1 {
            font-size: 1.6em;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
            margin-bottom: 16px;
        }

        .message-bubble h2 {
            font-size: 1.4em;
            margin-bottom: 12px;
        }

        .message-bubble h3 {
            font-size: 1.2em;
            margin-bottom: 10px;
        }

        .message-bubble h4 {
            font-size: 1.1em;
            font-weight: 600;
        }

        .message-bubble h5 {
            font-size: 1.05em;
            font-weight: 600;
        }

        .message-bubble h6 {
            font-size: 1em;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
        }

        .message-bubble p {
            margin: 12px 0;
            line-height: 1.6;
            color: var(--vscode-foreground);
        }

        .message-bubble p:first-child {
            margin-top: 0;
        }

        .message-bubble p:last-child {
            margin-bottom: 0;
        }

        .message-bubble ul, .message-bubble ol {
            margin: 12px 0;
            padding-left: 24px;
        }

        .message-bubble ul {
            list-style-type: disc;
        }

        .message-bubble ol {
            list-style-type: decimal;
        }

        .message-bubble li {
            margin: 6px 0;
            line-height: 1.6;
            color: var(--vscode-foreground);
        }

        .message-bubble li::marker {
            color: var(--vscode-descriptionForeground);
        }

        .message-bubble strong {
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .message-bubble em {
            font-style: italic;
            color: var(--vscode-foreground);
        }

        .message-bubble .inline-code {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-editor-foreground);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', monospace;
            font-size: 10px;
            border: 1px solid var(--vscode-input-border);
        }

        .message-bubble .code-block-container {
            margin: 16px 0;
            border-radius: 8px;
            overflow: hidden;
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-input-border);
            box-shadow: 0 2px 8px var(--vscode-widget-shadow);
        }

        .message-bubble .code-block-header {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-descriptionForeground);
            padding: 10px 16px;
            font-size: 0.8em;
            font-weight: 500;
            border-bottom: 1px solid var(--vscode-panel-border);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .message-bubble .code-block {
            background-color: var(--vscode-textCodeBlock-background) !important;
            color: var(--vscode-editor-foreground);
            padding: 20px;
            margin: 0;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', monospace;
            font-size: 10px;
            line-height: 1.6;
            overflow-x: auto;
            white-space: pre;
            word-wrap: normal;
            tab-size: 4;
        }

        .message-bubble .code-block code {
            background: none !important;
            padding: 0;
            color: inherit;
            font-size: inherit;
            font-family: inherit;
        }

        /* Enhanced VS Code syntax highlighting */
        .message-bubble .code-block .hljs {
            background: var(--vscode-textCodeBlock-background) !important;
            color: var(--vscode-editor-foreground) !important;
        }

        .message-bubble .code-block .hljs-keyword {
            color: var(--vscode-symbolIcon-keywordForeground, #569cd6) !important;
            font-weight: normal;
        }

        .message-bubble .code-block .hljs-string {
            color: var(--vscode-symbolIcon-stringForeground, #ce9178) !important;
        }

        .message-bubble .code-block .hljs-number {
            color: var(--vscode-symbolIcon-numberForeground, #b5cea8) !important;
        }

        .message-bubble .code-block .hljs-comment {
            color: var(--vscode-symbolIcon-colorForeground, #6a9955) !important;
            font-style: italic;
        }

        .message-bubble .code-block .hljs-function {
            color: var(--vscode-symbolIcon-functionForeground, #dcdcaa) !important;
        }

        .message-bubble .code-block .hljs-built_in {
            color: var(--vscode-symbolIcon-classForeground, #4ec9b0) !important;
        }

        .message-bubble .code-block .hljs-class {
            color: var(--vscode-symbolIcon-classForeground, #4ec9b0) !important;
        }

        .message-bubble .code-block .hljs-variable {
            color: var(--vscode-symbolIcon-variableForeground, #9cdcfe) !important;
        }

        .message-bubble .code-block .hljs-type {
            color: var(--vscode-symbolIcon-classForeground, #4ec9b0) !important;
        }

        .message-bubble .code-block .hljs-literal {
            color: var(--vscode-symbolIcon-keywordForeground, #569cd6) !important;
        }

        .message-bubble .code-block .hljs-operator {
            color: var(--vscode-editor-foreground, #d4d4d4) !important;
        }

        .message-bubble .code-block .hljs-punctuation {
            color: var(--vscode-editor-foreground, #d4d4d4) !important;
        }

        .message-bubble .code-block .hljs-property {
            color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe) !important;
        }

        .message-bubble .code-block .hljs-attr {
            color: var(--vscode-symbolIcon-propertyForeground, #92c5f8) !important;
        }

        .message-bubble .code-block .hljs-tag {
            color: var(--vscode-symbolIcon-keywordForeground, #569cd6) !important;
        }

        .message-bubble .code-block .hljs-name {
            color: var(--vscode-symbolIcon-classForeground, #4fc1ff) !important;
        }

        .message-bubble .code-block .hljs-title {
            color: var(--vscode-symbolIcon-functionForeground, #dcdcaa) !important;
        }

        .message-bubble .code-block .hljs-params {
            color: var(--vscode-symbolIcon-variableForeground, #9cdcfe) !important;
        }

        /* Additional markdown elements */
        .message-bubble blockquote {
            border-left: 3px solid var(--vscode-panel-border);
            margin: 16px 0;
            padding: 8px 0 8px 16px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            background-color: var(--vscode-textCodeBlock-background);
        }

        .message-bubble table {
            border-collapse: collapse;
            margin: 16px 0;
            width: 100%;
            border: 1px solid var(--vscode-panel-border);
        }

        .message-bubble th, .message-bubble td {
            border: 1px solid var(--vscode-panel-border);
            padding: 8px 12px;
            text-align: left;
        }

        .message-bubble th {
            background-color: var(--vscode-editor-background);
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        }

        .message-bubble hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 20px 0;
        }

        /* Links styling */
        .message-bubble a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .message-bubble a:hover {
            color: var(--vscode-textLink-activeForeground);
            text-decoration: underline;
        }

        .typing-indicator {
            display: none;
            margin-bottom: 16px;
            align-items: flex-start;
            flex-direction: column;
        }

        .typing-bubble {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 18px;
            padding: 12px 16px;
            color: var(--vscode-descriptionForeground);
            max-width: 80%;
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
            padding: 12px;
            background-color: var(--vscode-panel-background);
            border-top: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }

        .input-wrapper {
            background-color: var(--vscode-input-background);
            border: 1px solid transparent;
            border-radius: 24px;
            padding: 6px 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
            outline: none !important;
            box-sizing: border-box;
            position: relative;
            background-image: 
                linear-gradient(var(--vscode-input-background), var(--vscode-input-background)),
                linear-gradient(90deg, var(--vscode-focusBorder), var(--vscode-button-background), var(--vscode-focusBorder), var(--vscode-button-background), var(--vscode-focusBorder));
            background-origin: border-box;
            background-clip: padding-box, border-box;
            animation: borderFlow 3s linear infinite;
        }
        
        @keyframes borderFlow {
            0% {
                background-position: 0% 0%, 0% 0%;
            }
            100% {
                background-position: 0% 0%, 200% 0%;
            }
        }

        .input-wrapper:focus-within {
            background-image: 
                linear-gradient(var(--vscode-input-background), var(--vscode-input-background)),
                linear-gradient(90deg, var(--vscode-focusBorder), var(--vscode-button-background), var(--vscode-focusBorder), var(--vscode-button-background), var(--vscode-focusBorder));
            animation: borderFlowFocus 2s linear infinite;
            outline: none !important;
            box-shadow: none !important;
        }
        
        @keyframes borderFlowFocus {
            0% {
                background-position: 0% 0%, 0% 0%;
            }
            100% {
                background-position: 0% 0%, 300% 0%;
            }
        }

        .mode-dropdown {
            position: relative;
            flex-shrink: 0;
        }

        .mode-select {
            background-color: transparent;
            color: var(--vscode-descriptionForeground);
            border: none;
            border-radius: 4px;
            padding: 2px 14px 2px 4px;
            font-family: var(--vscode-font-family);
            font-size: 11px;
            font-weight: 400;
            cursor: pointer;
            outline: none !important;
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
            min-width: 40px;
            transition: all 0.2s ease;
            box-shadow: none !important;
        }

        .mode-select:hover {
            background-color: var(--vscode-list-hoverBackground);
            color: var(--vscode-foreground);
            outline: none !important;
        }

        .mode-select:focus {
            background-color: var(--vscode-list-hoverBackground);
            color: var(--vscode-foreground);
            outline: none !important;
            box-shadow: none !important;
            border: none !important;
        }

        .mode-select:active {
            outline: none !important;
            box-shadow: none !important;
        }

        .mode-select option {
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            padding: 4px 8px;
            font-size: 11px;
        }

        .mode-dropdown::after {
            content: '▼';
            position: absolute;
            right: 4px;
            top: 50%;
            transform: translateY(-50%);
            pointer-events: none;
            color: var(--vscode-descriptionForeground);
            font-size: 8px;
            opacity: 0.7;
        }

        .message-input {
            flex: 1;
            background-color: transparent;
            color: var(--vscode-input-foreground);
            border: none;
            padding: 6px 8px;
            font-family: var(--vscode-font-family);
            font-size: 13px;
            resize: none;
            outline: none !important;
            min-height: 18px;
            height: 18px;
            max-height: 120px;
            overflow-y: hidden;
            overflow-wrap: break-word;
            word-wrap: break-word;
            line-height: 1.4;
            box-shadow: none !important;
            vertical-align: top;
        }

        .message-input:focus {
            outline: none !important;
            box-shadow: none !important;
            border: none !important;
        }

        .message-input:active {
            outline: none !important;
            box-shadow: none !important;
        }

        .message-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
            font-size: 13px;
        }

        .send-button {
            background-color: transparent;
            color: var(--vscode-focusBorder);
            border: 1px solid var(--vscode-focusBorder);
            border-radius: 4px;
            width: 28px;
            height: 28px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            transition: all 0.2s ease;
            flex-shrink: 0;
            outline: none !important;
            box-shadow: none !important;
        }

        .send-button:hover {
            background-color: var(--vscode-focusBorder);
            color: var(--vscode-input-background);
            border: 1px solid var(--vscode-focusBorder);
            outline: none !important;
        }

        .send-button:focus {
            outline: none !important;
            box-shadow: none !important;
        }

        .send-button:active {
            outline: none !important;
            box-shadow: none !important;
        }

        .send-button:disabled {
            background-color: transparent;
            color: var(--vscode-disabledForeground);
            border: 1px solid var(--vscode-disabledForeground);
            cursor: not-allowed;
            outline: none !important;
        }

        .send-button:disabled:hover {
            background-color: transparent;
            color: var(--vscode-disabledForeground);
            border: 1px solid var(--vscode-disabledForeground);
            outline: none !important;
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
                    I can help you with your code, algorithms, programming concepts, and more..
                </div>
            </div>
        </div>

        <div class="input-container">
            <div class="input-wrapper">
                <div class="mode-dropdown">
                    <select id="modeSelect" class="mode-select">
                        <option value="ask">Ask</option>
                        <option value="learn">Learn</option>
                    </select>
                </div>
                <textarea 
                    id="messageInput" 
                    class="message-input" 
                    placeholder="Quick question? Ask here…"
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
        const modeSelect = document.getElementById('modeSelect');
        let typingIndicator = null;

        // Markdown renderer function - GitHub Copilot style
        function renderMarkdown(text) {
            let html = text;
            
            // Store code blocks to prevent interference with other processing
            const codeBlocks = [];
            let codeBlockIndex = 0;
            
            // First, extract and process code blocks (triple backticks)
            html = html.replace(/\`\`\`(\\w+)?\\n?([\\s\\S]*?)\`\`\`/g, function(match, lang, code) {
                const language = lang || 'text';
                const displayLang = lang || 'code';
                const codeId = 'code-' + Math.random().toString(36).substr(2, 9);
                
                const cleanCode = code.trim();
                const placeholder = \`___CODE_BLOCK_\${codeBlockIndex}___\`;
                
                codeBlocks[codeBlockIndex] = 
                    '<div class="code-block-container">' +
                    '<div class="code-block-header">' + displayLang + '</div>' +
                    '<pre class="code-block"><code id="' + codeId + '" class="language-' + language + '">' + 
                    cleanCode.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + 
                    '</code></pre></div>';
                
                codeBlockIndex++;
                return placeholder;
            });

            // Now process the rest of the markdown (escaping HTML entities for non-code content)
            html = html
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#x27;');

            // Headers (must be at start of line)
            html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
            html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
            html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
            html = html.replace(/^#### (.*$)/gm, '<h4>$1</h4>');
            html = html.replace(/^##### (.*$)/gm, '<h5>$1</h5>');
            html = html.replace(/^###### (.*$)/gm, '<h6>$1</h6>');

            // Bold text (**text** or __text__)
            html = html.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
            html = html.replace(/__([^_\\n]+)__/g, '<strong>$1</strong>');

            // Italic text (*text* or _text_) - but not within words
            html = html.replace(/(?:^|\\s)\\*([^*\\n]+)\\*(?=\\s|$|[.,!?])/g, function(match, content) {
                return match.replace('*' + content + '*', '<em>' + content + '</em>');
            });

            // Inline code (backticks) - after we've handled code blocks
            html = html.replace(/\`([^\`\\n]+)\`/g, '<code class="inline-code">$1</code>');

            // Links [text](url)
            html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');

            // Lists - bullet points
            const lines = html.split('\\n');
            const processedLines = [];
            let inList = false;
            let listType = null;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Check for bullet list items
                if (line.match(/^[-*+] (.+)/)) {
                    const content = line.replace(/^[-*+] /, '');
                    if (!inList || listType !== 'ul') {
                        if (inList && listType === 'ol') {
                            processedLines.push('</ol>');
                        }
                        processedLines.push('<ul>');
                        inList = true;
                        listType = 'ul';
                    }
                    processedLines.push('<li>' + content + '</li>');
                }
                // Check for numbered list items
                else if (line.match(/^\\d+\\. (.+)/)) {
                    const content = line.replace(/^\\d+\\. /, '');
                    if (!inList || listType !== 'ol') {
                        if (inList && listType === 'ul') {
                            processedLines.push('</ul>');
                        }
                        processedLines.push('<ol>');
                        inList = true;
                        listType = 'ol';
                    }
                    processedLines.push('<li>' + content + '</li>');
                }
                else {
                    // Close any open list
                    if (inList) {
                        processedLines.push(listType === 'ul' ? '</ul>' : '</ol>');
                        inList = false;
                        listType = null;
                    }
                    processedLines.push(line);
                }
            }
            
            // Close any remaining open list
            if (inList) {
                processedLines.push(listType === 'ul' ? '</ul>' : '</ol>');
            }
            
            html = processedLines.join('\\n');

            // Handle paragraphs - split by double newlines and wrap in <p> tags
            const paragraphs = html.split(/\\n\\s*\\n/);
            const processedParagraphs = [];
            
            for (const paragraph of paragraphs) {
                const trimmed = paragraph.trim();
                if (trimmed) {
                    // Don't wrap headers, lists, or code block placeholders in <p> tags
                    if (trimmed.match(/^<h[1-6]>/) || 
                        trimmed.match(/^<[uo]l>/) || 
                        trimmed.match(/___CODE_BLOCK_\\d+___/) ||
                        trimmed.match(/^<\\/[uo]l>/)) {
                        processedParagraphs.push(trimmed);
                    } else {
                        // Convert single newlines within paragraphs to <br> tags
                        const withBreaks = trimmed.replace(/\\n/g, '<br>');
                        processedParagraphs.push('<p>' + withBreaks + '</p>');
                    }
                }
            }
            
            html = processedParagraphs.join('\\n\\n');

            // Restore code blocks
            for (let i = 0; i < codeBlocks.length; i++) {
                html = html.replace(\`___CODE_BLOCK_\${i}___\`, codeBlocks[i]);
            }

            // Clean up any extra whitespace and empty elements
            html = html.replace(/<p>\\s*<\\/p>/g, '');
            html = html.replace(/\\n{3,}/g, '\\n\\n');

            return html;
        }

        // Initialize send button state
        sendButton.disabled = true;
        console.log('Initial button state: disabled');

        // Update placeholder text and input value based on mode
        function updatePlaceholder() {
            const mode = modeSelect.value;
            console.log('Updating placeholder for mode:', mode);
            if (mode === 'learn') {
                messageInput.placeholder = 'Learn about algorithms and data structures';
                // Pre-fill the input with learn mode text
                messageInput.value = 'Help me learn this question';
                // Enable send button since there's content
                sendButton.disabled = false;
                console.log('Learn mode: button enabled');
                // Set appropriate height for pre-filled content
                messageInput.style.height = '18px';
                messageInput.style.overflowY = 'hidden';
                // Check if content needs more height
                if (messageInput.scrollHeight > 20) {
                    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
                    messageInput.style.overflowY = messageInput.scrollHeight > 120 ? 'auto' : 'hidden';
                }
            } else {
                messageInput.placeholder = 'Quick question? Ask here…';
                // Clear input when switching to ask mode
                messageInput.value = '';
                // Disable send button since input is empty
                sendButton.disabled = true;
                console.log('Ask mode: button disabled');
                // Reset textarea to minimum height
                messageInput.style.height = '18px';
                messageInput.style.overflowY = 'hidden';
            }
        }

        // Set initial placeholder
        updatePlaceholder();

        // Handle mode change
        modeSelect.addEventListener('change', function() {
            updatePlaceholder();
        });

        // Auto-resize textarea and handle button state
        messageInput.addEventListener('input', function() {
            // Reset to minimum height first to get accurate scrollHeight
            this.style.height = '18px';
            
            // Calculate if content needs more height
            const currentScrollHeight = this.scrollHeight;
            
            // If content requires more space than current height, expand
            if (currentScrollHeight > 18) {
                this.style.height = Math.min(currentScrollHeight, 120) + 'px';
            }
            
            // Handle overflow when max height is reached
            this.style.overflowY = currentScrollHeight > 120 ? 'auto' : 'hidden';
            
            // Enable/disable send button based on content
            const hasContent = this.value.trim().length > 0;
            sendButton.disabled = !hasContent;
            console.log('Input changed. Has content:', hasContent, 'Button disabled:', sendButton.disabled);
        });

        // Send message on Enter (but allow Shift+Enter for new lines)
        messageInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                if (!sendButton.disabled) {
                    sendMessage();
                }
                return false;
            }
        });

        // Add click event listener to send button
        sendButton.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (!sendButton.disabled) {
                sendMessage();
            }
        });

        function sendMessage() {
            const message = messageInput.value.trim();
            if (!message) {
                console.log('No message to send');
                return;
            }
            
            const selectedMode = modeSelect.value;
            console.log('Sending message:', message, 'Mode:', selectedMode);
            
            // Clear input and reset button state
            messageInput.value = '';
            messageInput.style.height = '18px';
            messageInput.style.overflowY = 'hidden';
            sendButton.disabled = true;

            // Send to extension with mode included
            vscode.postMessage({
                type: 'sendMessage',
                message: message,
                mode: selectedMode
            });
        }

        function addMessage(message) {
            // Remove welcome message if it exists
            const welcomeMessage = document.querySelector('.welcome-message');
            if (welcomeMessage) {
                welcomeMessage.remove();
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + (message.isUser ? 'user' : 'assistant');
            
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble';
            
            // For AI messages, render as markdown; for user messages, keep as plain text
            if (message.isUser) {
                bubble.textContent = message.text;
            } else {
                bubble.innerHTML = renderMarkdown(message.text);
                
                // Apply syntax highlighting to code blocks
                setTimeout(() => {
                    const codeBlocks = bubble.querySelectorAll('pre code');
                    codeBlocks.forEach((block) => {
                        // Apply highlighting if hljs is available
                        if (typeof hljs !== 'undefined') {
                            hljs.highlightElement(block);
                        }
                    });
                }, 10);
            }
            
            messageDiv.appendChild(bubble);
            messagesContainer.appendChild(messageDiv);
            
            // Scroll to bottom
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function showTyping() {
            // Remove existing typing indicator if any
            if (typingIndicator) {
                typingIndicator.remove();
            }
            
            // Create new typing indicator
            typingIndicator = document.createElement('div');
            typingIndicator.className = 'typing-indicator';
            typingIndicator.style.display = 'flex';
            
            const typingBubble = document.createElement('div');
            typingBubble.className = 'typing-bubble';
            
            const typingDots = document.createElement('div');
            typingDots.className = 'typing-dots';
            
            // Create the three dots
            for (let i = 0; i < 3; i++) {
                const span = document.createElement('span');
                typingDots.appendChild(span);
            }
            
            typingBubble.appendChild(typingDots);
            typingIndicator.appendChild(typingBubble);
            
            // Append to bottom of messages container
            messagesContainer.appendChild(typingIndicator);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function hideTyping() {
            if (typingIndicator) {
                typingIndicator.remove();
                typingIndicator = null;
            }
        }

        // Handle messages from extension
        window.addEventListener('message', function(event) {
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
                    // Hide typing indicator first
                    hideTyping();
                    // Reset messages container
                    messagesContainer.innerHTML = 
            '<div class="welcome-message">' +
                '<div class="welcome-logo">{  }</div>' +
                '<div class="welcome-title">Ask Cipher</div>' +
                '<div class="welcome-subtitle">' +
                    'I can help you with your code, algorithms, programming concepts, and more..' +
                '</div>' +
            '</div>';
                    break;
                case 'requestCurrentMode':
                    // Respond with current mode for clear chat functionality
                    vscode.postMessage({
                        type: 'currentModeResponse',
                        mode: modeSelect.value
                    });
                    break;
            }
        });

        // Request initial messages when webview loads
        vscode.postMessage({
            type: 'requestMessages'
        });
    </script>
</body>
</html>`;
    }

    // WebSocket Implementation
    private initializeWebSocket() {
        try {
            console.log('🔄 Initializing WebSocket connection...');
            this._webSocket = new WebSocket('ws://127.0.0.1:7778');
            
            this._webSocket.on('open', () => {
                console.log('✅ WebSocket connected');
                this._isConnected = true;
                
                // Tell backend this client is ready
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                const question = workspaceFolder?.name || 'Unknown';
                
                this.sendWebSocketMessage({
                    type: 'client_register',
                    clientId: this._clientId,
                    question: question
                });
            });

            this._webSocket.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleBackendMessage(message);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            });

            this._webSocket.on('close', () => {
                console.log('🔌 WebSocket disconnected');
                this._isConnected = false;
                
                // Since backend is always running, try to reconnect once
                if (this._reconnectTimeout) {
                    clearTimeout(this._reconnectTimeout);
                }
                
                this._reconnectTimeout = setTimeout(() => {
                    console.log('🔄 Attempting to reconnect...');
                    this.initializeWebSocket();
                }, 2000); // 2 second delay for local connections
            });

            this._webSocket.on('error', (error) => {
                console.log('❌ WebSocket error:', error.message);
                this._isConnected = false;
            });

        } catch (error) {
            console.log('❌ WebSocket initialization failed:', error);
            this._isConnected = false;
        }
    }

    private handleBackendMessage(data: any) {
        console.log('📨 Received backend message:', data.type);
        
        switch (data.type) {
            case 'backend_message':
                this.addBackendInitiatedMessage(data.message, data.messageType || 'notification');
                break;
            case 'chat_message':
                this.addAIResponse(data.message);
                break;
            case 'submission_response':
                // Handle submission results
                if (this._activityProvider && data.response) {
                    this._activityProvider.addActivity('submission', data.response, data.problemName);
                    
                    const status = data.response.output?.metadata?.overall_status || 'Unknown';
                    
                    // Dispose the original "Submitting..." status message
                    const submitStatusMessage = this._activeStatusMessages.get('submit');
                    if (submitStatusMessage) {
                        submitStatusMessage.dispose();
                        this._activeStatusMessages.delete('submit');
                    }
                    
                    // Show auto-dismissing completion status bar message
                    const statusMessage = vscode.window.setStatusBarMessage(
                        `$(check) Submission completed: ${status}`,
                        5000 // Auto-dismiss after 5 seconds
                    );
                }
                break;
            case 'run_response':
                // Handle run results
                if (this._activityProvider && data.response) {
                    this._activityProvider.addActivity('run', data.response, data.problemName);
                    
                    const status = data.response.output?.metadata?.overall_status || 'Unknown';
                    
                    // Dispose the original "Running..." status message
                    const runStatusMessage = this._activeStatusMessages.get('run');
                    if (runStatusMessage) {
                        runStatusMessage.dispose();
                        this._activeStatusMessages.delete('run');
                    }
                    
                    // Show auto-dismissing completion status bar message
                    const statusMessage = vscode.window.setStatusBarMessage(
                        `$(play) Run completed: ${status}`,
                        5000 // Auto-dismiss after 5 seconds
                    );
                }
                break;
            case 'ping':
                // Respond to backend ping
                this.sendWebSocketMessage({ type: 'pong', clientId: this._clientId });
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    }

    private addBackendInitiatedMessage(message: string, messageType: string) {
        const backendMessage: ChatMessage = {
            text: message,
            isUser: false,
            timestamp: new Date().toISOString(),
            id: this.generateId(),
            isBackendInitiated: true
        };

        ChatViewProvider._messages.push(backendMessage);
        
        // Update all instances
        ChatViewProvider._updateAllViews('addMessage', { message: backendMessage });
    }

    private addAIResponse(response: string) {
        const aiMessage: ChatMessage = {
            text: response,
            isUser: false,
            timestamp: new Date().toISOString(),
            id: this.generateId()
        };

        ChatViewProvider._messages.push(aiMessage);
        
        // Update all instances
        ChatViewProvider._updateAllViews('hideTyping', {});
        ChatViewProvider._updateAllViews('addMessage', { message: aiMessage });
    }

    // Public method to send WebSocket messages from extension commands
    public sendMessage(data: any, statusMessage?: vscode.Disposable): boolean {
        // Store status message for submission requests
        if (data.type === 'VS_SUBMIT' && statusMessage) {
            this._activeStatusMessages.set('submit', statusMessage);
        } else if (data.type === 'VS_RUN' && statusMessage) {
            this._activeStatusMessages.set('run', statusMessage);
        }
        
        return this.sendWebSocketMessage(data);
    }

    private sendWebSocketMessage(data: any): boolean {
        if (this._isConnected && this._webSocket?.readyState === WebSocket.OPEN) {
            try {
                this._webSocket.send(JSON.stringify(data));
                return true;
            } catch (error) {
                console.error('Failed to send WebSocket message:', error);
                return false;
            }
        }
        return false;
    }

    // Cleanup WebSocket on disposal
    public dispose() {
        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
        }
        if (this._webSocket) {
            this._webSocket.close();
        }
        
        // Clean up any active status messages
        this._activeStatusMessages.forEach((statusMessage) => {
            statusMessage.dispose();
        });
        this._activeStatusMessages.clear();
    }

    private async clearCheckpoints(question?: string, path?: string, mode: string = 'clear'): Promise<void> {
        try {
            // Send clear chat request via WebSocket
            const sent = this.sendWebSocketMessage({
                type: 'clear_chat',
                question: question,
                path: path,
                mode: mode,
                clientId: this._clientId
            });

            if (!sent) {
                console.log('Failed to send clear chat request via WebSocket - not connected');
            } else {
                console.log('Clear chat request sent via WebSocket');
            }
            
        } catch (error) {
            console.error('Error sending clear chat request:', error);
        }
    }

    private getGitStatusString(status: number): string {
        // Git status constants from VS Code Git extension
        switch (status) {
            case 0: return 'Untracked';
            case 1: return 'Modified';
            case 2: return 'Added';
            case 3: return 'Deleted';
            case 4: return 'Renamed';
            case 5: return 'Copied';
            case 6: return 'Updated';
            case 7: return 'Unmerged';
            default: return 'Unknown';
        }
    }
}
