import * as vscode from 'vscode';
import { buildTree, CallNode, MAX_DEPTH, NodeBudget, prepareCallHierarchyItem } from '../callGraph/build';
import { categoriesPresent, CATEGORY_COLORS, CATEGORY_LABELS, GraphNode, toGraph } from '../callGraph/model';
import { renderSvg, RootAnchor } from '../callGraph/svg';
import { clearDetailsCache, computeNodeDetails, ParentRef } from '../details/compute';
import { DetailsReplyMessage, InvalidateMessage, WebviewToHostMessage } from '../protocol';
import { openLocation } from '../util';
import { flowPanelHtml } from './html';

interface ExpandContext {
    uriString: string;
    line: number;
    character: number;
}

export class FlowPanelController implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private context: ExpandContext | undefined;
    private isShowingParents = false;
    private invalidateTimer: NodeJS.Timeout | undefined;

    constructor(private readonly extensionUri: vscode.Uri) {}

    // edits anywhere can change what the details card would show; drop both caches
    // (debounced — this fires per keystroke while the panel is open)
    private scheduleInvalidate(): void {
        if (this.invalidateTimer) {
            clearTimeout(this.invalidateTimer);
        }
        this.invalidateTimer = setTimeout(() => {
            clearDetailsCache();
            const message: InvalidateMessage = { type: 'invalidate' };
            void this.panel?.webview.postMessage(message);
        }, 300);
    }

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
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'callCharts.flow',
                `Flow: ${functionName}`,
                vscode.ViewColumn.Active,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
                }
            );
            const changeSubscription = vscode.workspace.onDidChangeTextDocument(() => this.scheduleInvalidate());
            this.panel.onDidDispose(() => {
                changeSubscription.dispose();
                this.panel = undefined;
            });
            this.panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => this.onMessage(message));
        }
        const webview = this.panel.webview;
        const mediaUri = (file: string): string =>
            webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file)).toString();
        this.panel.title = `Flow: ${functionName}`;
        webview.html = flowPanelHtml({
            svgMarkup,
            legend,
            anchor,
            hasParents: this.isShowingParents,
            styleUri: mediaUri('styles.css'),
            scriptUri: mediaUri('main.js'),
            cspSource: webview.cspSource,
        });
        this.panel.reveal(vscode.ViewColumn.Active);
    }

    private async onMessage(message: WebviewToHostMessage): Promise<void> {
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
            const reply: DetailsReplyMessage = { type: 'details', nodeId: message.nodeId, details };
            await this.panel?.webview.postMessage(reply);
        }
    }
}
