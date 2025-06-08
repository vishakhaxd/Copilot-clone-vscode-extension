import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

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
                    await this.handleUserMessage(data.message, data.mode);
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

    private async handleUserMessage(message: string, mode: string = 'ask') {
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
            const aiResponse = await this.generateAIResponse(message, mode);
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

    private async generateAIResponse(userMessage: string, mode: string = 'ask'): Promise<string> {
        // Gather context before generating response
        const context = await this.gatherVSCodeContext();
        
        // Get response from local API
        const response = await this.getContextualResponses(userMessage, context, mode);
        
        return response;
    }

    private async getContextualResponses(message: string, context?: VSCodeContext, mode: string = 'ask'): Promise<string> {
        try {
            const requestBody = JSON.stringify({
                message: message,
                mode: mode,
                context: context
            });

            return new Promise((resolve, reject) => {
                const options = {
                    hostname: '127.0.0.1', // Using explicit IP instead of localhost
                    port: 7777,
                    path: '/cypher-agent',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(requestBody)
                    }
                };

                const req = http.request(options, (res) => {
                    let data = '';

                    res.on('data', (chunk) => {
                        data += chunk;
                    });

                    res.on('end', () => {
                        // Check if the response status is not successful
                        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                            resolve(`API Error: Received status code ${res.statusCode}. Please check if your API server is running and the endpoint is correct.`);
                            return;
                        }

                        try {
                            const response = JSON.parse(data);
                            // Assuming the API returns an object with a 'response' field containing the text
                            // Adjust this based on your actual API response format
                            const result = response.response || response.message || response.text || response.content || "I received a response from the API, but couldn't parse it properly.";
                            resolve(result);
                        } catch (parseError) {
                            resolve(`API returned non-JSON response: ${data.substring(0, 200)}${data.length > 200 ? '...' : ''}`);
                        }
                    });
                });

                req.on('error', (error) => {
                    resolve("I'm sorry, I'm having trouble connecting to my processing service right now. Please try again in a moment.");
                });

                req.on('timeout', () => {
                    resolve("The request timed out. Please try again.");
                });

                // Set a timeout
                req.setTimeout(30000); // 30 seconds timeout

                req.write(requestBody);
                req.end();
            });
            
        } catch (error) {
            // Fallback response in case of API failure
            return "I'm sorry, I'm having trouble connecting to my processing service right now. Please try again in a moment.";
        }
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:; connect-src *;">
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
            white-space: normal;
        }

        /* Markdown Styles */
        .message-bubble h1, .message-bubble h2, .message-bubble h3 {
            margin: 8px 0 4px 0;
            color: var(--vscode-foreground);
        }

        .message-bubble h1 {
            font-size: 1.5em;
            font-weight: 600;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 4px;
        }

        .message-bubble h2 {
            font-size: 1.3em;
            font-weight: 600;
        }

        .message-bubble h3 {
            font-size: 1.1em;
            font-weight: 600;
        }

        .message-bubble p {
            margin: 8px 0;
            line-height: 1.6;
        }

        .message-bubble ul, .message-bubble ol {
            margin: 8px 0;
            padding-left: 20px;
        }

        .message-bubble li {
            margin: 4px 0;
            line-height: 1.5;
        }

        .message-bubble strong {
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .message-bubble em {
            font-style: italic;
            color: var(--vscode-descriptionForeground);
        }

        .message-bubble .inline-code {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family, 'SF Mono', Monaco, 'Inconsolata', 'Roboto Mono', 'Source Code Pro', monospace);
            font-size: 0.9em;
        }

        .message-bubble .code-block-container {
            margin: 12px 0;
            border-radius: 6px;
            overflow: hidden;
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
        }

        .message-bubble .code-block-header {
            background-color: var(--vscode-tab-inactiveBackground);
            color: var(--vscode-tab-inactiveForeground);
            padding: 8px 12px;
            font-size: 0.8em;
            font-weight: 500;
            border-bottom: 1px solid var(--vscode-panel-border);
            text-transform: uppercase;
        }

        .message-bubble .code-block {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 12px;
            margin: 0;
            font-family: var(--vscode-editor-font-family, 'SF Mono', Monaco, 'Inconsolata', 'Roboto Mono', 'Source Code Pro', monospace);
            font-size: 0.9em;
            line-height: 1.4;
            overflow-x: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .message-bubble .code-block code {
            background: none;
            padding: 0;
            color: inherit;
            font-size: inherit;
        }

        /* Additional markdown styles */
        .message-bubble blockquote {
            border-left: 3px solid var(--vscode-panel-border);
            margin: 8px 0;
            padding-left: 12px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }

        .message-bubble table {
            border-collapse: collapse;
            margin: 8px 0;
            width: 100%;
        }

        .message-bubble th, .message-bubble td {
            border: 1px solid var(--vscode-panel-border);
            padding: 6px 8px;
            text-align: left;
        }

        .message-bubble th {
            background-color: var(--vscode-tab-inactiveBackground);
            font-weight: 600;
        }

        .message-bubble hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 16px 0;
        }

        /* Links (if any) */
        .message-bubble a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .message-bubble a:hover {
            color: var(--vscode-textLink-activeForeground);
            text-decoration: underline;
        }

        /* Fix paragraph spacing */
        .message-bubble p:first-child {
            margin-top: 0;
        }

        .message-bubble p:last-child {
            margin-bottom: 0;
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
            padding: 16px;
            background-color: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }

        .input-top-row {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            margin-bottom: 8px;
            padding-bottom: 4px;
        }

        .mode-dropdown {
            position: relative;
            display: inline-block;
        }

        .mode-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-right: 8px;
            line-height: 28px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .mode-select {
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 6px;
            padding: 6px 28px 6px 12px;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            outline: none;
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            min-width: 100px;
            position: relative;
            transition: all 0.2s ease;
        }

        .mode-select:focus {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }

        .mode-select:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-input-border);
        }

        .mode-select option {
            background-color: var(--vscode-dropdown-listBackground);
            color: var(--vscode-dropdown-foreground);
            padding: 8px 12px;
        }

        .mode-dropdown::after {
            content: '▼';
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            pointer-events: none;
            color: var(--vscode-foreground);
            font-size: 8px;
            opacity: 0.7;
            transition: opacity 0.2s ease;
        }

        .mode-dropdown:hover::after {
            opacity: 1;
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

        <div class="input-container">
            <div class="input-top-row">
                <span class="mode-label">Mode:</span>
                <div class="mode-dropdown">
                    <select id="modeSelect" class="mode-select">
                        <option value="ask">Ask</option>
                        <option value="learn">Learn</option>
                    </select>
                </div>
            </div>
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
        const modeSelect = document.getElementById('modeSelect');
        let typingIndicator = null;

        // Markdown renderer function
        function renderMarkdown(text) {
            // Escape HTML entities first
            let html = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#x27;');

            // Code blocks (triple backticks)
            html = html.replace(/\\\`\\\`\\\`(\\w+)?\\n?([\\s\\S]*?)\\\`\\\`\\\`/g, function(match, lang, code) {
                const language = lang ? ' data-language="' + lang + '"' : '';
                const displayLang = lang || 'code';
                return '<div class="code-block-container"><div class="code-block-header">' + displayLang + '</div><pre class="code-block"' + language + '><code>' + code.trim() + '</code></pre></div>';
            });

            // Inline code (backticks)
            html = html.replace(/\\\`([^\\\`\\n]+)\\\`/g, '<code class="inline-code">$1</code>');

            // Bold text
            html = html.replace(/\\*\\*([^\\*\\n]+)\\*\\*/g, '<strong>$1</strong>');
            html = html.replace(/__([^_\\n]+)__/g, '<strong>$1</strong>');

            // Italic text (simple version)
            html = html.replace(/(?:^|\\s)\\*([^\\*\\n]+)\\*(?=\\s|$)/g, ' <em>$1</em>');
            html = html.replace(/(?:^|\\s)_([^_\\n]+)_(?=\\s|$)/g, ' <em>$1</em>');

            // Headers (must be at start of line)
            html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
            html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
            html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

            // Links [text](url)
            html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');

            // Process lists - handle bullet points
            html = html.replace(/^[\\*\\-\\+] (.+)$/gm, '<li>$1</li>');
            
            // Process numbered lists
            html = html.replace(/^\\d+\\. (.+)$/gm, '<li class="numbered">$1</li>');

            // Wrap consecutive list items in ul/ol tags
            html = html.replace(/(<li>.*?<\\/li>)(\\s*<li>.*?<\\/li>)*/gs, function(match) {
                return '<ul>' + match + '</ul>';
            });
            
            html = html.replace(/(<li class="numbered">.*?<\\/li>)(\\s*<li class="numbered">.*?<\\/li>)*/gs, function(match) {
                const cleanMatch = match.replace(/class="numbered"/g, '');
                return '<ol>' + cleanMatch + '</ol>';
            });

            // Convert double newlines to paragraph breaks
            html = html.replace(/\\n\\n+/g, '</p><p>');
            
            // Convert single newlines to line breaks
            html = html.replace(/\\n/g, '<br>');

            // Wrap in paragraph if not already wrapped in block elements
            if (html.indexOf('<h1>') === -1 && html.indexOf('<h2>') === -1 && html.indexOf('<h3>') === -1 && 
                html.indexOf('<ul>') === -1 && html.indexOf('<ol>') === -1 && html.indexOf('<div class="code-block') === -1 &&
                html.indexOf('<p>') === -1) {
                html = '<p>' + html + '</p>';
            }

            // Clean up any empty paragraphs
            html = html.replace(/<p><\\/p>/g, '');

            return html;
        }

        // Initialize send button state
        sendButton.disabled = true;

        // Update placeholder text based on mode
        function updatePlaceholder() {
            const mode = modeSelect.value;
            if (mode === 'learn') {
                messageInput.placeholder = 'What would you like to learn about?';
            } else {
                messageInput.placeholder = 'Ask Cipher...';
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
            
            const selectedMode = modeSelect.value;
            
            // Clear input and reset button state
            messageInput.value = '';
            messageInput.style.height = 'auto';
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
                    'Your AI assistant for algorithms, data structures, and coding challenges.' +
                '</div>' +
            '</div>';
                    break;
            }
        });
    </script>
</body>
</html>`;
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
