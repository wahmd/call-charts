import * as vscode from 'vscode';
import { LANGUAGES, provideHover, toggleCallers } from './hover';
import { FlowPanelController } from './panel/controller';
import { openLocation } from './util';

export function activate(context: vscode.ExtensionContext): void {
    const flowPanel = new FlowPanelController();
    context.subscriptions.push(
        flowPanel,
        vscode.commands.registerCommand('callCharts.goto', openLocation),
        vscode.commands.registerCommand('callCharts.callers', toggleCallers),
        vscode.commands.registerCommand('callCharts.expand', (uriString: string, line: number, character: number) =>
            flowPanel.expand(uriString, line, character)
        ),
        vscode.languages.registerHoverProvider(LANGUAGES, { provideHover })
    );
}

export function deactivate(): void {}
