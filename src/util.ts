import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface WorkspaceInfo {
    path: string;
    name: string;
}

function getWorkspaceInfo(): WorkspaceInfo | null {
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor?.document) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (workspaceFolder) {
            return {
                path: workspaceFolder.uri.fsPath,
                name: workspaceFolder.name
            };
        }
    }

    if (vscode.workspace.workspaceFolders?.length) {
        const folder = vscode.workspace.workspaceFolders[0];
        return {
            path: folder.uri.fsPath,
            name: folder.name
        };
    }

    return null;
}

export { getWorkspaceInfo, WorkspaceInfo };
