import * as vscode from 'vscode';
import { logError } from './log';

export function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function basename(uri: vscode.Uri): string {
    return uri.path.split('/').pop() ?? '';
}

export function escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// executeCommand with failures logged instead of thrown; use for calls that should normally succeed
export async function tryCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
    try {
        return await vscode.commands.executeCommand<T>(command, ...args);
    } catch (error) {
        logError(`command ${command}`, error);
        return undefined;
    }
}

export async function openLocation(uriString: string, line: number, character: number): Promise<void> {
    const position = new vscode.Position(line, character);
    await vscode.window.showTextDocument(vscode.Uri.parse(uriString), {
        selection: new vscode.Range(position, position),
    });
}
