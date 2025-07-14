import * as vscode from 'vscode';

interface TestCase {
    status: 'PASS' | 'FAIL';
    [key: string]: any;
}

interface MemoryFootprint {
    heap_usage: number;
    stack_usage: number;
    total_ram: number;
}

interface MemoryLeak {
    definitely_lost: number;
    indirectly_lost: number;
    possibly_lost: number;
    still_reachable: number;
    suppressed: number;
}

interface CacheProfile {
    l1_miss: number;
    l2_miss: number;
    branch_miss: number;
}

interface MemoryStats {
    footprint: MemoryFootprint;
    memory_leak: MemoryLeak;
    cache_profile: CacheProfile;
}

interface Metadata {
    Total_Time: number;
    overall_status: 'PASS' | 'FAIL';
    mem_stat: MemoryStats;
}

interface SubmissionOutput {
    metadata: Metadata;
    test_cases: { [key: string]: TestCase };
}

interface SubmissionResponse {
    status: 'PASS' | 'FAIL';
    output: SubmissionOutput;
}

interface ActivityData {
    type: 'submission' | 'run';
    timestamp: string;
    response: SubmissionResponse;
    problemName?: string;
}

export class ActivityViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'dsp-cipher.activity';
    private _view?: vscode.WebviewView;
    private static _activities: ActivityData[] = []; // Make it static to persist across instances
    private static _instances: ActivityViewProvider[] = []; // Track all instances

    constructor(private readonly _extensionUri: vscode.Uri) {
        // Add this instance to the static list
        ActivityViewProvider._instances.push(this);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'requestActivities':
                    // Send current activities when requested
                    this._updateView();
                    break;
            }
        });

        // Clean up when webview is disposed
        webviewView.onDidDispose(() => {
            const index = ActivityViewProvider._instances.indexOf(this);
            if (index > -1) {
                ActivityViewProvider._instances.splice(index, 1);
            }
        });

        // Load existing activities when view is resolved - use setTimeout to ensure webview is fully loaded
        setTimeout(() => {
            this._updateView();
        }, 100);
    }

    public addActivity(type: 'submission' | 'run', response: SubmissionResponse, problemName?: string) {
        const activity: ActivityData = {
            type,
            timestamp: new Date().toISOString(),
            response,
            problemName
        };
        
        ActivityViewProvider._activities.unshift(activity); // Add to beginning
        
        // Keep only last 50 activities
        if (ActivityViewProvider._activities.length > 50) {
            ActivityViewProvider._activities = ActivityViewProvider._activities.slice(0, 50);
        }
        
        // Update all instances
        ActivityViewProvider._updateAllViews();
    }

    private static _updateAllViews() {
        // Update all active instances
        ActivityViewProvider._instances.forEach(instance => {
            if (instance._view) {
                instance._view.webview.postMessage({
                    type: 'updateActivities',
                    activities: ActivityViewProvider._activities
                });
            }
        });
    }

    private _updateView() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateActivities',
                activities: ActivityViewProvider._activities
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Activity Manager</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 12px;
            font-size: 13px;
            line-height: 1.4;
        }

        .empty-state {
            text-align: center;
            padding: 32px 16px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state .icon {
            font-size: 32px;
            margin-bottom: 12px;
            opacity: 0.6;
        }

        .empty-state h3 {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .empty-state p {
            font-size: 12px;
            opacity: 0.8;
        }

        .activity-item {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            margin-bottom: 12px;
            overflow: hidden;
            transition: all 0.2s ease;
        }

        .activity-item:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        .activity-header {
            padding: 16px;
            background: linear-gradient(135deg, var(--vscode-tab-inactiveBackground), rgba(var(--vscode-charts-blue-rgb, 0, 122, 255), 0.02));
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: relative;
        }

        .activity-header::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 16px;
            right: 16px;
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--vscode-charts-blue), transparent);
            opacity: 0.3;
        }

        .activity-type {
            display: flex;
            align-items: center;
            gap: 10px;
            font-weight: 600;
            font-size: 13px;
        }

        .type-badge {
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 9px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }

        .type-submission {
            background: linear-gradient(135deg, var(--vscode-charts-blue), #4A90E2);
            color: white;
        }

        .type-run {
            background: linear-gradient(135deg, var(--vscode-charts-green), #50C878);
            color: white;
        }

        .activity-time {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            padding: 3px 6px;
            background: rgba(var(--vscode-charts-blue-rgb, 0, 122, 255), 0.05);
            border-radius: 6px;
            border: 1px solid rgba(var(--vscode-charts-blue-rgb, 0, 122, 255), 0.1);
        }

        .activity-content {
            padding: 14px;
        }

        .status-overview {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 18px;
        }

        .status-card {
            background: linear-gradient(135deg, var(--vscode-editor-background), rgba(var(--vscode-charts-blue-rgb, 0, 122, 255), 0.03));
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 14px;
            position: relative;
            overflow: hidden;
            transition: all 0.3s ease;
        }

        .status-card:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            transform: translateY(-1px);
        }

        .status-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, var(--vscode-charts-blue), var(--vscode-charts-green));
        }

        .status-card h3 {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .status-card h3::before {
            font-size: 12px;
        }

        .status-card:first-child h3::before {
            content: '🎯';
        }

        .status-card:last-child h3::before {
            content: '⚡';
        }

        .status-value {
            font-size: 18px;
            font-weight: 700;
            line-height: 1;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .status-value::after {
            font-size: 12px;
            opacity: 0.7;
        }

        .status-pass {
            color: var(--vscode-charts-green);
        }

        .status-pass::after {
            content: '✅';
        }

        .status-fail {
            color: var(--vscode-charts-red);
        }

        .status-fail::after {
            content: '❌';
        }

        .time-value {
            color: var(--vscode-charts-blue);
            font-family: var(--vscode-editor-font-family);
            font-size: 16px;
        }

        .time-value::after {
            content: '⏱️';
        }

        .test-results {
            margin: 16px 0;
        }

        .test-results h3 {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 12px;
            color: var(--vscode-editor-foreground);
        }

        .progress-bar-container {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
        }

        .progress-bar-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .progress-bar-title {
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-editor-foreground);
        }

        .progress-bar-stats {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }

        .progress-bar {
            width: 100%;
            height: 6px;
            background: var(--vscode-input-background);
            border-radius: 3px;
            overflow: hidden;
            position: relative;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--vscode-charts-green) 0%, var(--vscode-charts-green) 100%);
            border-radius: 3px;
            transition: width 0.8s ease-out;
            position: relative;
        }

        .progress-fill::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.2) 50%, transparent 100%);
            animation: shimmer 2s infinite;
        }

        @keyframes shimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }

        .detailed-breakdown {
            margin-top: 8px;
            display: flex;
            gap: 12px;
            font-size: 11px;
        }

        .breakdown-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .breakdown-icon {
            width: 6px;
            height: 6px;
            border-radius: 50%;
        }

        .breakdown-icon.pass {
            background: var(--vscode-charts-green);
        }

        .breakdown-icon.fail {
            background: var(--vscode-charts-red);
        }

        .memory-stats {
            margin: 16px 0;
        }

        .memory-stats h3 {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 12px;
            color: var(--vscode-editor-foreground);
        }

        .memory-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }

        .memory-section {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
            transition: all 0.2s ease;
        }

        .memory-section:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 1px 4px rgba(0,0,0,0.08);
        }

        .memory-section h4 {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .memory-section h4::before {
            content: '';
            width: 8px;
            height: 8px;
            border-radius: 2px;
            background: linear-gradient(45deg, var(--vscode-charts-blue), var(--vscode-charts-green));
        }

        .memory-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
            padding: 6px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 11px;
        }

        .memory-item:last-child {
            border-bottom: none;
            margin-bottom: 0;
        }

        .memory-label {
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .memory-label::before {
            content: '';
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: var(--vscode-charts-blue);
            opacity: 0.7;
        }

        .memory-value {
            font-weight: 600;
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-editor-font-family);
            background: rgba(var(--vscode-charts-blue-rgb, 0, 122, 255), 0.1);
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 10px;
        }

        .cache-performance .memory-label::before {
            background: var(--vscode-charts-orange);
        }

        .performance-summary {
            display: none; /* Hide performance insights section */
        }

        .performance-summary h5 {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
        }

        .performance-badges {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .performance-badge {
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 9px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }

        .performance-badge.memory {
            background: rgba(var(--vscode-charts-blue-rgb, 0, 122, 255), 0.15);
            color: var(--vscode-charts-blue);
            border: 1px solid rgba(var(--vscode-charts-blue-rgb, 0, 122, 255), 0.3);
        }

        .performance-badge.cache {
            background: rgba(var(--vscode-charts-orange-rgb, 255, 165, 0), 0.15);
            color: var(--vscode-charts-orange);
            border: 1px solid rgba(var(--vscode-charts-orange-rgb, 255, 165, 0), 0.3);
        }

        .performance-badge.clean {
            background: rgba(var(--vscode-charts-green-rgb, 0, 128, 0), 0.15);
            color: var(--vscode-charts-green);
            border: 1px solid rgba(var(--vscode-charts-green-rgb, 0, 128, 0), 0.3);
        }

        .actions {
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
            display: none; /* Hide actions section completely */
        }

        .collapsible {
            cursor: pointer;
        }

        .collapsible:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .collapsible.collapsed .activity-content {
            display: none;
        }

        .collapse-icon {
            transition: transform 0.2s ease;
        }

        .collapsed .collapse-icon {
            transform: rotate(-90deg);
        }

        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .activity-item {
            animation: slideIn 0.3s ease;
        }
    </style>
</head>
<body>
    <div id="activities-container">
        <div class="empty-state">
            <div class="icon">📊</div>
            <h3>No Activities Yet</h3>
            <p>Submit your code to see results here</p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let activities = [];

        function toggleCollapse(element) {
            element.classList.toggle('collapsed');
        }

        function formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function formatTime(milliseconds) {
            return milliseconds.toFixed(0) + 'ms';
        }

        function getRelativeTime(timestamp) {
            const now = new Date();
            const time = new Date(timestamp);
            const diff = Math.floor((now - time) / 1000);
            
            if (diff < 60) return 'Just now';
            if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
            if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
            return Math.floor(diff / 86400) + 'd ago';
        }

        function renderActivities() {
            const container = document.getElementById('activities-container');
            
            if (activities.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="icon">📊</div>
                        <h3>No Activities Yet</h3>
                        <p>Submit your code to see results here</p>
                    </div>
                \`;
                return;
            }

            container.innerHTML = activities.map((activity, index) => {
                const { response } = activity;
                const { metadata, test_cases } = response.output;
                
                const testCaseEntries = Object.entries(test_cases);
                const passedTests = testCaseEntries.filter(([_, test]) => test.status === 'PASS').length;
                const totalTests = testCaseEntries.length;
                const successRate = (passedTests / totalTests) * 100;
                
                // Auto-minimize: only the first (most recent) activity is expanded
                const isCollapsed = index > 0 ? 'collapsed' : '';
                
                return \`
                    <div class="activity-item collapsible \${isCollapsed}" onclick="toggleCollapse(this)">
                        <div class="activity-header">
                            <div class="activity-type">
                                <span class="collapse-icon">▼</span>
                                <span class="type-badge type-\${activity.type}">\${activity.type}</span>
                                \${activity.problemName ? activity.problemName : 'Code Submission'}
                            </div>
                            <div class="activity-time">\${getRelativeTime(activity.timestamp)}</div>
                        </div>
                        
                        <div class="activity-content">
                            <div class="status-overview">
                                <div class="status-card">
                                    <h3>Overall Status</h3>
                                    <div class="status-value status-\${metadata.overall_status.toLowerCase()}">\${metadata.overall_status}</div>
                                </div>
                                <div class="status-card">
                                    <h3>Execution Time</h3>
                                    <div class="status-value time-value">\${formatTime(metadata.Total_Time)}</div>
                                </div>
                            </div>

                            <div class="test-results">
                                <h3>📊 Test Results</h3>
                                
                                <div class="progress-bar-container">
                                    <div class="progress-bar-header">
                                        <div class="progress-bar-title">Test Case Progress</div>
                                        <div class="progress-bar-stats">\${passedTests}/\${totalTests} completed</div>
                                    </div>
                                    <div class="progress-bar">
                                        <div class="progress-fill" style="width: \${successRate}%"></div>
                                    </div>
                                    <div class="detailed-breakdown">
                                        <div class="breakdown-item">
                                            <div class="breakdown-icon pass"></div>
                                            <span>\${passedTests} tests passed</span>
                                        </div>
                                        <div class="breakdown-item">
                                            <div class="breakdown-icon fail"></div>
                                            <span>\${totalTests - passedTests} tests failed</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="memory-stats">
                                <h3>⚡ Performance & Memory Analysis</h3>
                                <div class="memory-grid">
                                    <div class="memory-section">
                                        <h4>Memory Footprint</h4>
                                        <div class="memory-item">
                                            <span class="memory-label">Heap Usage</span>
                                            <span class="memory-value">\${formatBytes(metadata.mem_stat.footprint.heap_usage)}</span>
                                        </div>
                                        <div class="memory-item">
                                            <span class="memory-label">Stack Usage</span>
                                            <span class="memory-value">\${formatBytes(metadata.mem_stat.footprint.stack_usage)}</span>
                                        </div>
                                        <div class="memory-item">
                                            <span class="memory-label">Total RAM</span>
                                            <span class="memory-value">\${formatBytes(metadata.mem_stat.footprint.total_ram)}</span>
                                        </div>
                                    </div>
                                    
                                    <div class="memory-section cache-performance">
                                        <h4>Cache Performance</h4>
                                        <div class="memory-item">
                                            <span class="memory-label">L1 Misses</span>
                                            <span class="memory-value">\${metadata.mem_stat.cache_profile.l1_miss.toLocaleString()}</span>
                                        </div>
                                        <div class="memory-item">
                                            <span class="memory-label">L2 Misses</span>
                                            <span class="memory-value">\${metadata.mem_stat.cache_profile.l2_miss.toLocaleString()}</span>
                                        </div>
                                        <div class="memory-item">
                                            <span class="memory-label">Branch Misses</span>
                                            <span class="memory-value">\${metadata.mem_stat.cache_profile.branch_miss.toLocaleString()}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="actions">
                                <!-- Actions section hidden via CSS -->
                            </div>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateActivities':
                    activities = message.activities;
                    renderActivities();
                    break;
            }
        });

        // Initial render
        renderActivities();

        // Request initial data load from extension
        vscode.postMessage({ type: 'requestActivities' });
    </script>
</body>
</html>`;
    }
}
