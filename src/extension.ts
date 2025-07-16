import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { getWorkspaceInfo } from './util';
import { ProblemDescriptionProvider } from './problemDescriptionProvider';
import { ActivityViewProvider } from './activityViewProvider';

export function activate(context: vscode.ExtensionContext) {
    // Set context for when chat is enabled
    vscode.commands.executeCommand('setContext', 'dsp-cipher.chatEnabled', true);

    // Register activity view provider
    const activityProvider = new ActivityViewProvider(context.extensionUri);
    const activityDisposable = vscode.window.registerWebviewViewProvider('dsp-cipher.activity', activityProvider);
    context.subscriptions.push(activityDisposable);

    // Register chat view provider with activity provider reference
    const chatProvider = new ChatViewProvider(context.extensionUri, activityProvider);
    const chatDisposable = vscode.window.registerWebviewViewProvider('dsp-cipher.chat', chatProvider);    
    context.subscriptions.push(chatDisposable);

    // Create problem description provider instance
    const problemDescriptionProvider = new ProblemDescriptionProvider();

    // Automatically open problem description when extension activates
    // Add a small delay to ensure WebSocket has time to connect
    setTimeout(() => {
        problemDescriptionProvider.openProblemDescription();
    }, 1000); // 1 second delay

    // Register command to open chat
    const openChatCommand = vscode.commands.registerCommand('dsp-cipher.openChat', () => {
        vscode.commands.executeCommand('dsp-cipher.chat.focus');
    });

    // Register command to open activity manager
    const openActivityCommand = vscode.commands.registerCommand('dsp-cipher.openActivity', () => {
        vscode.commands.executeCommand('dsp-cipher.activity.focus');
    });

    // Register command to open problem description
    const openProblemDescriptionCommand = vscode.commands.registerCommand('dsp-cipher.openProblemDescription', () => {
        problemDescriptionProvider.openProblemDescription();
    });

    // Register command to add test activity (for demo purposes)
    const addTestActivityCommand = vscode.commands.registerCommand('dsp-cipher.addTestActivity', () => {
        // Create different test scenarios
        const scenarios = [
            {
                name: 'Two Sum Problem',
                status: 'FAIL' as const,
                time: 31.868408203125,
                passedTests: 5,
                totalTests: 20
            },
            {
                name: 'Binary Tree Traversal',
                status: 'PASS' as const,
                time: 15.234,
                passedTests: 15,
                totalTests: 15
            },
            {
                name: 'Dynamic Programming - Fibonacci',
                status: 'FAIL' as const,
                time: 42.123,
                passedTests: 8,
                totalTests: 12
            }
        ];

        const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
        
        // Generate test cases based on scenario
        const testCases: any = {};
        for (let i = 1; i <= scenario.totalTests; i++) {
            testCases[`test_case_${i}`] = {
                status: i <= scenario.passedTests ? 'PASS' as const : 'FAIL' as const
            };
        }

        const testResponse = {
            status: 'PASS' as const,
            output: {
                metadata: {
                    Total_Time: scenario.time,
                    overall_status: scenario.status,
                    mem_stat: {
                        footprint: {
                            heap_usage: Math.floor(Math.random() * 10000000) + 2000000,
                            stack_usage: Math.floor(Math.random() * 100000) + 20000,
                            total_ram: Math.floor(Math.random() * 15000000) + 3000000
                        },
                        memory_leak: {
                            definitely_lost: 0,
                            indirectly_lost: 0,
                            possibly_lost: 0,
                            still_reachable: 0,
                            suppressed: 0
                        },
                        cache_profile: {
                            l1_miss: Math.floor(Math.random() * 50000),
                            l2_miss: Math.floor(Math.random() * 1000),
                            branch_miss: Math.floor(Math.random() * 5000)
                        }
                    }
                },
                test_cases: testCases
            }
        };
        activityProvider.addActivity('submission', testResponse, scenario.name);
        vscode.window.showInformationMessage(`Test activity "${scenario.name}" added! Check the Activity Manager.`);
        vscode.commands.executeCommand('dsp-cipher.activity.focus');
    });

    // Register command to clear chat
    const clearChatCommand = vscode.commands.registerCommand('dsp-cipher.clearChat', () => {
        chatProvider.clearChat();
        vscode.window.showInformationMessage('Chat history cleared!');
    });

    // Register command to run code
    const runCodeCommand = vscode.commands.registerCommand('dsp-cipher.run', () => {
        const message = vscode.window.setStatusBarMessage('$(sync~spin) Running codebase ...');
        try {   
                const workspaceInfo = getWorkspaceInfo();
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                const folderName = workspaceFolder?.name || workspaceInfo?.name || 'Unknown';
                
                // Send WebSocket message with status bar message reference
                const sent = chatProvider.sendMessage({
                    type: 'VS_RUN',
                    folder_name: folderName
                }, message); // Pass the status bar message to chatProvider

                if (!sent) {
                    vscode.window.showErrorMessage(`Run failed - WebSocket not connected`);
                    message.dispose(); // Dispose immediately if failed
                } else {
                    console.log('✅ VS_RUN message sent via WebSocket:', folderName);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Run failed try again`);
                message.dispose(); // Dispose immediately if error
            }
    });

    // Register command to submit code
    const submitCodeCommand = vscode.commands.registerCommand('dsp-cipher.submit', () => {
        const message = vscode.window.setStatusBarMessage('$(sync~spin) Submitting codebase ...');
        try {   
                const workspaceInfo = getWorkspaceInfo();
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                const folderName = workspaceFolder?.name || workspaceInfo?.name || 'Unknown';
                
                // Send WebSocket message with status bar message reference
                const sent = chatProvider.sendMessage({
                    type: 'VS_SUBMIT',
                    folder_name: folderName
                }, message); // Pass the status bar message to chatProvider

                if (!sent) {
                    vscode.window.showErrorMessage(`Submit failed - WebSocket not connected`);
                    message.dispose(); // Dispose immediately if failed
                } else {
                    console.log('✅ VS_SUBMIT message sent via WebSocket:', folderName);
                    // Auto-popup the submission panel (activity manager) after successful submit
                    vscode.commands.executeCommand('dsp-cipher.activity.focus');
                }
            } catch (err) {
                vscode.window.showErrorMessage(`submit failed try again`);
                message.dispose(); // Dispose immediately if error
            }
    });

    context.subscriptions.push(openChatCommand, clearChatCommand, runCodeCommand, submitCodeCommand, openActivityCommand, openProblemDescriptionCommand, addTestActivityCommand);
    
    // Add problem description provider to subscriptions for proper cleanup
    context.subscriptions.push({
        dispose: () => problemDescriptionProvider.dispose()
    });
}

export function deactivate() {
    console.log('Cipher deactivated');
}
