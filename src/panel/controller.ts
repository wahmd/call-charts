import * as vscode from 'vscode';
import { buildTree, CallNode, MAX_DEPTH, NodeBudget, prepareCallHierarchyItem } from '../callGraph/build';
import { categoriesPresent, CATEGORY_COLORS, CATEGORY_LABELS, GraphNode, toGraph } from '../callGraph/model';
import { renderSvg, RootAnchor } from '../callGraph/svg';
import { clearDetailsCache, computeNodeDetails, ParentRef } from '../details/compute';
import { openLocation } from '../util';
import { flowPanelHtml } from './html';

interface FlowPanelMessage {
    type: 'open' | 'close' | 'details' | 'callers';
    uri?: string;
    line?: number;
    character?: number;
    nodeId?: string;
    parentUri?: string;
    parentLine?: number;
    parentCharacter?: number;
    shouldShow?: boolean;
}

interface ExpandContext {
    uriString: string;
    line: number;
    character: number;
}

export class FlowPanelController implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private context: ExpandContext | undefined;
    private isShowingParents = false;

    async expand(uriString: string, line: number, character: number): Promise<void> {
        this.context = { uriString, line, character };
        this.isShowingParents = false;
        await this.render();
    }

    dispose(): void {
        this.panel?.dispose();
    }

    private async render(): Promise<void> {
        if (!this.context) {
            return;
        }
        const uri = vscode.Uri.parse(this.context.uriString);
        const root = await prepareCallHierarchyItem(
            uri,
            new vscode.Position(this.context.line, this.context.character)
        );
        if (!root) {
            return;
        }
        clearDetailsCache();
        const token = new vscode.CancellationTokenSource().token;
        const outBudget: NodeBudget = { used: 0, isExhausted: false };
        const inBudget: NodeBudget = { used: 0, isExhausted: false };
        const outTree = await buildTree(root, MAX_DEPTH, outBudget, new Set<string>(), token, 'outgoing');
        // parents are opt-in here too: only traced after the "show parents" button
        const inTree: CallNode = this.isShowingParents
            ? await buildTree(root, MAX_DEPTH, inBudget, new Set<string>(), token, 'incoming')
            : { item: root, children: [] };
        const callerGraph = toGraph(inTree, root.uri);
        const calleeGraph = toGraph(outTree, root.uri);
        const svg = renderSvg(callerGraph, calleeGraph, true);
        this.show(root.name, svg.markup, this.legend([callerGraph, calleeGraph]), svg.rootAnchor);
    }

    // node colors mean nothing without labels — build a swatch legend for the hint bar
    private legend(roots: GraphNode[]): string {
        return categoriesPresent(roots)
            .map(
                (category) =>
                    `<span class="lgi"><i style="background:${CATEGORY_COLORS[category]}"></i>${CATEGORY_LABELS[category]}</span>`
            )
            .join('');
    }

    private show(functionName: string, svgMarkup: string, legend: string, anchor: RootAnchor): void {
        const html = flowPanelHtml(svgMarkup, legend, anchor, this.isShowingParents);
        if (this.panel) {
            this.panel.title = `Flow: ${functionName}`;
            this.panel.webview.html = html;
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'callCharts.flow',
            `Flow: ${functionName}`,
            vscode.ViewColumn.Active,
            { enableScripts: true }
        );
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
        this.panel.webview.onDidReceiveMessage((message: FlowPanelMessage) => this.onMessage(message));
        this.panel.webview.html = html;
    }

    private async onMessage(message: FlowPanelMessage): Promise<void> {
        if (message.type === 'close') {
            this.panel?.dispose();
            return;
        }
        if (message.type === 'callers') {
            this.isShowingParents = message.shouldShow === true;
            await this.render();
            return;
        }
        if (message.type === 'open' && message.uri && message.line !== undefined && message.character !== undefined) {
            await openLocation(message.uri, message.line, message.character);
            return;
        }
        if (
            message.type === 'details' &&
            message.uri &&
            message.line !== undefined &&
            message.character !== undefined &&
            message.nodeId
        ) {
            const parent: ParentRef | undefined =
                message.parentUri && message.parentLine !== undefined && message.parentCharacter !== undefined
                    ? { uri: message.parentUri, line: message.parentLine, character: message.parentCharacter }
                    : undefined;
            const details = await computeNodeDetails(message.uri, message.line, message.character, parent).catch(
                () => undefined
            );
            await this.panel?.webview.postMessage({ type: 'details', nodeId: message.nodeId, details });
        }
    }
}
