import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as WebSocket from 'ws';

export class ProblemDescriptionProvider {
    private _markdownPath: string;
    private _panel?: vscode.WebviewPanel;
    private _webSocket?: WebSocket;
    private _isConnected: boolean = false;
    private _reconnectTimeout?: NodeJS.Timeout;    constructor() {
        // No hardcoded paths - path must come from WebSocket
        this._markdownPath = '';
        
        // Initialize WebSocket connection
        this.initializeWebSocket();
    }

    public async openProblemDescription() {
        try {
            console.log('🚀 Opening problem description...');
            console.log('🔗 WebSocket connected:', this._isConnected);
            
            // First try to get problem description from websocket
            const problemDescriptionPath = await this.getProblemDescriptionFromWebSocket();
            
            console.log('📁 Received path from WebSocket:', problemDescriptionPath);
            
            if (problemDescriptionPath) {
                this._markdownPath = problemDescriptionPath;
                console.log('✅ Updated markdown path to:', this._markdownPath);
            } else {
                console.log('⚠️ No path received from WebSocket, cannot display problem description');
                vscode.window.showWarningMessage('Problem description is not available. Please ensure the backend service is running and providing the problem path.');
                return;
            }

            if (!this._markdownPath) {
                vscode.window.showErrorMessage('Problem description path not available. Cannot display problem description.');
                return;
            }

            if (!fs.existsSync(this._markdownPath)) {
                vscode.window.showErrorMessage(`Problem description file not found: ${this._markdownPath}`);
                return;
            }

            // If panel already exists, just reveal it
            if (this._panel) {
                this._panel.reveal(vscode.ViewColumn.One);
                return;
            }

            // Read the problem description content
            const markdownContent = fs.readFileSync(this._markdownPath, 'utf8');

            // Create a webview panel for problem description
            this._panel = vscode.window.createWebviewPanel(
                'problemDescription',
                'Problem Description',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            // Prevent the panel from being disposed/closed
            this._panel.onDidDispose(() => {
                // Immediately recreate the panel when it's disposed
                setTimeout(() => {
                    this._panel = undefined;
                    this.openProblemDescription();
                }, 100);
            });

            // Set the webview content with rendered problem description
            this._panel.webview.html = this.getHtmlContent(markdownContent);

        } catch (error) {
            vscode.window.showErrorMessage(`Error opening problem description: ${error}`);
        }
    }

    private getHtmlContent(markdownContent: string): string {
        // Convert markdown to HTML for problem description display
        const html = this.markdownToHtml(markdownContent);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Problem Description</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
            line-height: 1.6;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
            max-width: 900px;
        }
        
        h1, h2, h3, h4, h5, h6 {
            color: var(--vscode-editor-foreground);
            margin-top: 24px;
            margin-bottom: 16px;
            font-weight: 600;
            line-height: 1.25;
        }
        
        h1 {
            font-size: 2em;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        
        h2 {
            font-size: 1.5em;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        
        h3 {
            font-size: 1.25em;
        }
        
        code {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.9em;
        }
        
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 16px;
            border-radius: 6px;
            overflow-x: auto;
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.9em;
            line-height: 1.45;
        }
        
        pre code {
            background-color: transparent;
            padding: 0;
        }
        
        a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        
        a:hover {
            text-decoration: underline;
        }
        
        strong {
            font-weight: 600;
        }
        
        em {
            font-style: italic;
        }
        
        ul, ol {
            margin: 16px 0;
            padding-left: 24px;
        }
        
        li {
            margin: 4px 0;
        }
        
        p {
            margin: 16px 0;
            line-height: 1.6;
        }
        
        blockquote {
            border-left: 4px solid var(--vscode-textLink-foreground);
            padding-left: 16px;
            margin: 16px 0;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    ${html}
</body>
</html>`;
    }

    private markdownToHtml(markdown: string): string {
        // Convert markdown to HTML for problem description rendering
        let html = markdown;
        
        // Headers
        html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
        
        // Bold and italic
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // Code blocks
        html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        html = html.replace(/`(.*?)`/g, '<code>$1</code>');
        
        // Lists
        html = html.replace(/^\* (.*$)/gm, '<li>$1</li>');
        html = html.replace(/^- (.*$)/gm, '<li>$1</li>');
        html = html.replace(/^\d+\. (.*$)/gm, '<li>$1</li>');
        
        // Wrap list items in ul tags
        html = html.replace(/(<li>.*<\/li>)/gs, (match) => {
            return '<ul>' + match + '</ul>';
        });
        
        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
        
        // Blockquotes
        html = html.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');
        
        // Paragraphs
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');
        
        // Wrap in paragraphs if not starting with a tag
        if (!html.trim().startsWith('<')) {
            html = '<p>' + html + '</p>';
        }
        
        return html;
    }

    public updateProblemDescriptionPath(newPath: string) {
        this._markdownPath = newPath;
    }

    // WebSocket Implementation
    private initializeWebSocket() {
        try {
            console.log('🔄 Initializing WebSocket connection for problem description...');
            this._webSocket = new WebSocket('ws://127.0.0.1:7778');
            
            this._webSocket.on('open', () => {
                console.log('✅ Problem Description WebSocket connected');
                this._isConnected = true;
            });

            this._webSocket.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleWebSocketMessage(message);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            });

            this._webSocket.on('close', () => {
                console.log('🔌 Problem Description WebSocket disconnected');
                this._isConnected = false;
                
                // Try to reconnect
                if (this._reconnectTimeout) {
                    clearTimeout(this._reconnectTimeout);
                }
                
                this._reconnectTimeout = setTimeout(() => {
                    console.log('🔄 Attempting to reconnect problem description WebSocket...');
                    this.initializeWebSocket();
                }, 2000);
            });

            this._webSocket.on('error', (error) => {
                console.log('❌ Problem Description WebSocket error:', error.message);
                this._isConnected = false;
            });

        } catch (error) {
            console.log('❌ Problem Description WebSocket initialization failed:', error);
            this._isConnected = false;
        }
    }

    private handleWebSocketMessage(data: any) {
        console.log('📨 Received problem description message:', data.type);
        
        switch (data.type) {
            case 'problem_description_response':
                if (data.path) {
                    this._markdownPath = data.path;
                    // Refresh the panel if it exists
                    if (this._panel) {
                        this.refreshProblemDescription();
                    }
                }
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
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

    private async getProblemDescriptionFromWebSocket(): Promise<string | null> {
        return new Promise((resolve) => {
            console.log('🔍 getProblemDescriptionFromWebSocket called');
            console.log('🔗 WebSocket connected:', this._isConnected);
            console.log('🔗 WebSocket ready state:', this._webSocket?.readyState);
            
            if (!this._isConnected) {
                console.log('❌ WebSocket not connected, cannot get problem description');
                resolve(null);
                return;
            }

            // Get current workspace folder name
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const folderName = workspaceFolder?.name;

            console.log('📂 Workspace folder:', folderName);

            if (!folderName) {
                console.log('❌ No workspace folder found, cannot display problem description');
                resolve(null);
                return;
            }

            console.log(`🔍 Requesting problem description for folder: ${folderName}`);

            // Send request to websocket
            const messageToSend = {
                type: 'give_problem_description',
                folder_name: folderName
            };
            
            console.log('📤 Sending WebSocket message:', JSON.stringify(messageToSend));
            
            const sent = this.sendWebSocketMessage(messageToSend);

            if (!sent) {
                console.log('❌ Failed to send WebSocket message, cannot proceed');
                resolve(null);
                return;
            }

            console.log('✅ WebSocket message sent successfully');

            // Set a timeout for the response
            const timeout = setTimeout(() => {
                console.log('⏰ WebSocket response timeout, cannot display problem description');
                resolve(null);
            }, 5000); // 5 second timeout

            // Listen for response
            const messageHandler = (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.log('📨 Received WebSocket response:', JSON.stringify(message));
                    
                    if (message.type === 'problem_description_response') {
                        console.log('✅ Got problem description response:', message.path);
                        clearTimeout(timeout);
                        this._webSocket?.off('message', messageHandler);
                        resolve(message.path || null);
                    }
                } catch (error) {
                    console.error('❌ Error parsing WebSocket response:', error);
                }
            };

            this._webSocket?.on('message', messageHandler);
        });
    }

    private async refreshProblemDescription() {
        try {
            if (!fs.existsSync(this._markdownPath)) {
                vscode.window.showErrorMessage(`Problem description file not found: ${this._markdownPath}`);
                return;
            }

            const markdownContent = fs.readFileSync(this._markdownPath, 'utf8');
            if (this._panel) {
                this._panel.webview.html = this.getHtmlContent(markdownContent);
            }
        } catch (error) {
            console.error('Error refreshing problem description:', error);
        }
    }

    // Cleanup WebSocket on disposal
    public dispose() {
        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
        }
        if (this._webSocket) {
            this._webSocket.close();
        }
    }
}
