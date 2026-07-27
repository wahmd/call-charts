import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('Call Charts');
    }
    return channel;
}

export function logError(scope: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    getChannel().appendLine(`[${new Date().toISOString()}] ${scope}: ${message}`);
}
