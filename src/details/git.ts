import * as vscode from 'vscode';
import { execFile } from 'child_process';

// last commit touching the function's line range, via `git log -L`;
// resolves undefined on any failure (no repo, untracked file, timeout)
export function gitSummary(uri: vscode.Uri, startLine: number, endLine: number): Promise<string | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (!folder || uri.scheme !== 'file') {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
        execFile(
            'git',
            ['log', '-1', '--format=%ar · %an · %s', `-L${startLine + 1},${endLine + 1}:${uri.fsPath}`],
            { cwd: folder, timeout: 3000 },
            (error, stdout) => {
                const first = stdout?.split('\n').find((outputLine) => outputLine.trim().length > 0);
                resolve(error || !first ? undefined : first.trim());
            }
        );
    });
}
