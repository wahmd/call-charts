import * as vscode from 'vscode';
import { execFile } from 'child_process';

const MAX_DEPTH = 3;
const MAX_NODES = 40;
const LANGUAGES = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];

type Direction = 'outgoing' | 'incoming';

// functions whose hover the user expanded with the callers button
const expandedCallers = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('callCharts.goto', openLocation),
        vscode.commands.registerCommand('callCharts.callers', toggleCallers),
        vscode.commands.registerCommand('callCharts.expand', expandGraph),
        vscode.languages.registerHoverProvider(LANGUAGES, { provideHover })
    );
}

export function deactivate(): void {}

async function toggleCallers(
    uriString: string,
    line: number,
    character: number,
    key: string,
    shouldShow: boolean
): Promise<void> {
    if (shouldShow) {
        expandedCallers.add(key);
    } else {
        expandedCallers.delete(key);
    }
    // reopen the hover at the spot the user was already hovering
    const position = new vscode.Position(line, character);
    await vscode.window.showTextDocument(vscode.Uri.parse(uriString), {
        selection: new vscode.Range(position, position),
    });
    await vscode.commands.executeCommand('editor.action.showHover');
}

async function openLocation(uriString: string, line: number, character: number): Promise<void> {
    const position = new vscode.Position(line, character);
    await vscode.window.showTextDocument(vscode.Uri.parse(uriString), {
        selection: new vscode.Range(position, position),
    });
}

// ---------- full-size flow panel ----------

let flowPanel: vscode.WebviewPanel | undefined;

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

interface RootAnchor {
    x: number;
    yCenter: number;
    width: number;
}

interface DetailGroup {
    kind: 'in' | 'out' | 'guards' | 'mutates' | 'callers' | 'git';
    entries: string[];
}

interface NodeDetails {
    name: string;
    location: string;
    signature: string;
    groups: DetailGroup[];
    facts: string[];
}

interface ParentRef {
    uri: string;
    line: number;
    character: number;
}

const detailsCache = new Map<string, NodeDetails | undefined>();

interface ExpandContext {
    uriString: string;
    line: number;
    character: number;
}

let expandContext: ExpandContext | undefined;
let isShowingParents = false;

async function expandGraph(uriString: string, line: number, character: number): Promise<void> {
    expandContext = { uriString, line, character };
    isShowingParents = false;
    await renderExpandPanel();
}

async function renderExpandPanel(): Promise<void> {
    if (!expandContext) {
        return;
    }
    const uri = vscode.Uri.parse(expandContext.uriString);
    let roots: vscode.CallHierarchyItem[] | undefined;
    try {
        roots = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            uri,
            new vscode.Position(expandContext.line, expandContext.character)
        );
    } catch {
        return;
    }
    const root = roots?.[0];
    if (!root) {
        return;
    }
    detailsCache.clear();
    const token = new vscode.CancellationTokenSource().token;
    const outBudget: NodeBudget = { used: 0, isExhausted: false };
    const inBudget: NodeBudget = { used: 0, isExhausted: false };
    const outTree = await buildTree(root, MAX_DEPTH, outBudget, new Set<string>(), token, 'outgoing');
    // parents are opt-in here too: only traced after the "show parents" button
    const inTree: CallNode = isShowingParents
        ? await buildTree(root, MAX_DEPTH, inBudget, new Set<string>(), token, 'incoming')
        : { item: root, children: [] };
    const callerGraph = toGraph(inTree, root.uri);
    const calleeGraph = toGraph(outTree, root.uri);
    const svg = renderSvg(callerGraph, calleeGraph, true);
    showFlowPanel(
        root.name,
        svg.markup,
        panelLegend([callerGraph, calleeGraph]),
        { x: calleeGraph.x, yCenter: calleeGraph.yCenter, width: calleeGraph.width },
        isShowingParents
    );
}

// node colors mean nothing without labels — build a swatch legend for the hint bar
function panelLegend(roots: GraphNode[]): string {
    const present = new Set<Category>();
    roots.forEach((graphRoot) => walkGraph(graphRoot, (node) => present.add(node.category)));
    return (Object.keys(CATEGORY_COLORS) as Category[])
        .filter((category) => present.has(category))
        .map(
            (category) =>
                `<span class="lgi"><i style="background:${CATEGORY_COLORS[category]}"></i>${CATEGORY_LABELS[category]}</span>`
        )
        .join('');
}

// ---------- hover-card details (deterministic, no AI) ----------

async function computeNodeDetails(
    uriString: string,
    line: number,
    character: number,
    parent?: ParentRef
): Promise<NodeDetails | undefined> {
    const cacheKey = `${uriString}:${line}:${character}:${parent ? `${parent.uri}:${parent.line}` : ''}`;
    if (detailsCache.has(cacheKey)) {
        return detailsCache.get(cacheKey);
    }
    const uri = vscode.Uri.parse(uriString);
    let roots: vscode.CallHierarchyItem[] | undefined;
    try {
        roots = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            uri,
            new vscode.Position(line, character)
        );
    } catch {
        roots = undefined;
    }
    const item = roots?.[0];
    if (!item) {
        detailsCache.set(cacheKey, undefined);
        return undefined;
    }
    const document = await vscode.workspace.openTextDocument(uri);

    const signature = extractSignature(document, item);
    const lineCount = item.range.end.line - item.range.start.line + 1;
    const groups: DetailGroup[] = [];

    let incoming: vscode.CallHierarchyIncomingCall[] = [];
    try {
        incoming =
            (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                'vscode.provideIncomingCalls',
                item
            )) ?? [];
    } catch {
        incoming = [];
    }

    // IN: the invocation line in the caller — prefer the edge the user is hovering
    const chosenCall =
        (parent &&
            incoming.find(
                (call) =>
                    call.from.uri.toString() === parent.uri &&
                    call.from.selectionRange.start.line === parent.line &&
                    call.from.selectionRange.start.character === parent.character
            )) ??
        incoming[0];
    const callSite = chosenCall?.fromRanges[0];
    if (chosenCall && callSite) {
        try {
            const callerDocument = await vscode.workspace.openTextDocument(chosenCall.from.uri);
            const siteText = truncate(callerDocument.lineAt(callSite.start.line).text.trim(), 64);
            groups.push({ kind: 'in', entries: [`${siteText}  — ${chosenCall.from.name}`] });
        } catch {
            // caller file unreadable: skip the row
        }
    }

    const { guards, exitLines } = extractGuards(document, item);
    const returns = extractReturns(document, item, exitLines);
    if (returns.length) {
        groups.push({ kind: 'out', entries: returns });
    }
    if (guards.length) {
        groups.push({ kind: 'guards', entries: guards });
    }
    const mutations = extractMutations(document, item);
    if (mutations.length) {
        groups.push({ kind: 'mutates', entries: [mutations.join(', ')] });
    }

    const callerNames = [...new Set(incoming.map((call) => call.from.name))];
    const callersEntry = callerNames.length
        ? callerNames.slice(0, 4).join(' · ') + (callerNames.length > 4 ? `  +${callerNames.length - 4}` : '')
        : 'none';
    groups.push({ kind: 'callers', entries: [truncate(callersEntry, 72)] });

    const git = await gitSummary(uri, item.range.start.line, item.range.end.line);
    if (git) {
        groups.push({ kind: 'git', entries: [truncate(git, 76)] });
    }

    const facts: string[] = [];
    if (/\basync\b/.test(signature)) {
        facts.push('async');
    }
    facts.push(`${lineCount} lines`);
    const paramCount = countParams(signature);
    if (paramCount !== undefined) {
        facts.push(`${paramCount} ${paramCount === 1 ? 'param' : 'params'}`);
    }
    try {
        const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls',
            item
        );
        const workspaceCallCount = (outgoing ?? []).filter((call) => !isExternal(call.to)).length;
        if (lineCount <= 6 && workspaceCallCount === 1) {
            facts.push('pass-through');
        }
    } catch {
        // pass-through chip is optional
    }

    const details: NodeDetails = {
        name: item.name,
        location: `${basename(uri)}:${item.selectionRange.start.line + 1}`,
        signature,
        groups,
        facts,
    };
    detailsCache.set(cacheKey, details);
    return details;
}

// the declaration as written in source, from the range start down to the body brace
function extractSignature(document: vscode.TextDocument, item: vscode.CallHierarchyItem): string {
    const maxLine = Math.min(item.range.start.line + 8, item.range.end.line);
    let text = '';
    for (let lineNo = item.range.start.line; lineNo <= maxLine; lineNo++) {
        const lineText = document.lineAt(lineNo).text;
        // the body brace follows ')' or '=>'; a bare indexOf('{') would trip on destructured params
        const bodyStart = /(\)|=>)\s*\{/.exec(lineText);
        if (bodyStart) {
            text += ' ' + lineText.slice(0, bodyStart.index + bodyStart[1].length);
            break;
        }
        text += ' ' + lineText;
    }
    const collapsed = text
        .replace(/\s+/g, ' ')
        .replace(/\s*=>\s*$/, '')
        .replace(/\s*=\s*$/, '')
        .trim();
    return collapsed.length > 220 ? `${collapsed.slice(0, 219)}…` : collapsed;
}

function countParams(signature: string): number | undefined {
    const open = signature.indexOf('(');
    if (open < 0) {
        return undefined;
    }
    let parens = 0;
    let angles = 0;
    let braces = 0;
    let brackets = 0;
    let count = 0;
    let hasContent = false;
    for (let i = open; i < signature.length; i++) {
        const char = signature[i];
        if (char === '(') {
            parens++;
        } else if (char === ')') {
            parens--;
            if (parens === 0) {
                break;
            }
        } else if (char === '<') {
            angles++;
        } else if (char === '>') {
            angles = Math.max(0, angles - 1);
        } else if (char === '{') {
            braces++;
        } else if (char === '}') {
            braces--;
        } else if (char === '[') {
            brackets++;
        } else if (char === ']') {
            brackets--;
        } else if (char === ',' && parens === 1 && !angles && !braces && !brackets) {
            count++;
        } else if (!/\s/.test(char)) {
            hasContent = true;
        }
    }
    return hasContent ? count + 1 : 0;
}

// guard clauses: `if (...) return/throw` on one line or split across two
function extractGuards(
    document: vscode.TextDocument,
    item: vscode.CallHierarchyItem
): { guards: string[]; exitLines: Set<number> } {
    const guards: string[] = [];
    const exitLines = new Set<number>();
    for (let lineNo = item.range.start.line; lineNo <= item.range.end.line && guards.length < 3; lineNo++) {
        const text = document.lineAt(lineNo).text;
        const singleLine = /\bif\s*\((.+?)\)\s*\{?\s*(return|throw)\b\s*(.*?)[;{]?\s*$/.exec(text);
        if (singleLine) {
            exitLines.add(lineNo);
            guards.push(formatGuard(singleLine[1], singleLine[2], singleLine[3]));
            continue;
        }
        const opener = /\bif\s*\((.+)\)\s*\{\s*$/.exec(text);
        if (!opener || lineNo + 1 > item.range.end.line) {
            continue;
        }
        const exit = /^\s*(return|throw)\b\s*(.*?);?\s*$/.exec(document.lineAt(lineNo + 1).text);
        if (exit) {
            exitLines.add(lineNo + 1);
            guards.push(formatGuard(opener[1], exit[1], exit[2]));
        }
    }
    return { guards, exitLines };
}

function formatGuard(condition: string, keyword: string, rest: string): string {
    const tail = rest.trim() ? ` ${truncate(rest.trim().replace(/^new\s+/, ''), 28)}` : '';
    return `if (${truncate(condition.trim(), 38)}) → ${keyword}${tail}`;
}

// return expressions, skipping lines already shown as guard exits
function extractReturns(
    document: vscode.TextDocument,
    item: vscode.CallHierarchyItem,
    skipLines: Set<number>
): string[] {
    const returns: string[] = [];
    for (let lineNo = item.range.start.line + 1; lineNo <= item.range.end.line && returns.length < 2; lineNo++) {
        if (skipLines.has(lineNo)) {
            continue;
        }
        const match = /^\s*return\b\s*(.*?);?\s*$/.exec(document.lineAt(lineNo).text);
        if (!match) {
            continue;
        }
        const expression = match[1] ? truncate(match[1], 64) : '(void)';
        if (!returns.includes(expression)) {
            returns.push(expression);
        }
    }
    return returns;
}

// state writes: `this.x = ...`
function extractMutations(document: vscode.TextDocument, item: vscode.CallHierarchyItem): string[] {
    const names = new Set<string>();
    for (let lineNo = item.range.start.line + 1; lineNo <= item.range.end.line; lineNo++) {
        const pattern = /\bthis\.([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
        const text = document.lineAt(lineNo).text;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text))) {
            names.add(match[1]);
        }
    }
    return [...names].slice(0, 6);
}

// last commit touching the function's line range, via `git log -L`
function gitSummary(uri: vscode.Uri, startLine: number, endLine: number): Promise<string | undefined> {
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

function showFlowPanel(
    functionName: string,
    svgMarkup: string,
    legend: string,
    anchor: RootAnchor,
    hasParents: boolean
): void {
    const html = flowPanelHtml(svgMarkup, legend, anchor, hasParents);
    if (flowPanel) {
        flowPanel.title = `Flow: ${functionName}`;
        flowPanel.webview.html = html;
        flowPanel.reveal(vscode.ViewColumn.Active);
        return;
    }
    flowPanel = vscode.window.createWebviewPanel('callCharts.flow', `Flow: ${functionName}`, vscode.ViewColumn.Active, {
        enableScripts: true,
    });
    flowPanel.onDidDispose(() => {
        flowPanel = undefined;
    });
    flowPanel.webview.onDidReceiveMessage(async (message: FlowPanelMessage) => {
        if (message.type === 'close') {
            flowPanel?.dispose();
            return;
        }
        if (message.type === 'callers') {
            isShowingParents = message.shouldShow === true;
            await renderExpandPanel();
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
            const parent =
                message.parentUri && message.parentLine !== undefined && message.parentCharacter !== undefined
                    ? { uri: message.parentUri, line: message.parentLine, character: message.parentCharacter }
                    : undefined;
            const details = await computeNodeDetails(message.uri, message.line, message.character, parent).catch(
                () => undefined
            );
            await flowPanel?.webview.postMessage({ type: 'details', nodeId: message.nodeId, details });
        }
    });
    flowPanel.webview.html = html;
}

function flowPanelHtml(svgMarkup: string, legend: string, anchor: RootAnchor, hasParents: boolean): string {
    const buttonLeft = Math.round(anchor.x + anchor.width / 2);
    const buttonTop = Math.round(anchor.yCenter + 15 + 9);
    const buttonLabel = hasParents ? '× hide parents' : '⟨ show parents';
    const nonce = 'callChartsFlowPanel';
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { margin: 0; padding: 10px 16px; }
#hint {
    color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px;
    display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
}
.lgi { font-size: 11px; margin-left: 10px; white-space: nowrap; }
.lgi i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
#parentsBtn {
    position: absolute; transform: translateX(-50%);
    font: inherit; font-size: 10.5px; white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 20px; padding: 2px 11px; cursor: pointer;
}
#parentsBtn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder, #6e7681); }
#wrap { position: relative; transform-origin: 0 0; width: max-content; }
.fn-node { cursor: pointer; transition: filter .25s ease; }
.fn-node rect { transition: stroke-width .15s ease; }
.fn-node:hover rect { stroke-width: 3; }
#wrap path { transition: stroke .25s ease, stroke-width .25s ease, filter .25s ease; }
#card {
    position: absolute; width: 430px; z-index: 10; display: none;
    flex-direction: column; gap: 8px;
    background: var(--vscode-editorWidget-background, #1f2229);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 8px; padding: 11px 13px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    font-size: 12px;
}
#card.open { display: flex; animation: cardIn .18s ease-out; }
@keyframes cardIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { #card.open { animation: none; } }
#card .head { display: flex; align-items: baseline; gap: 8px; }
#card .name { font-weight: 600; font-size: 13px; }
#card .loc { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; flex: none; }
#card .code {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11.5px;
    background: rgba(128, 128, 128, 0.09); border-radius: 5px; padding: 6px 9px;
    overflow-x: auto; white-space: pre;
}
#card .row { display: flex; gap: 8px; align-items: baseline; }
#card .glyph { flex: none; width: 14px; text-align: center; font-weight: 700; font-size: 12px; }
#card .rowlabel { flex: none; width: 66px; color: var(--vscode-descriptionForeground); font-size: 9.5px; letter-spacing: .07em; text-transform: uppercase; }
#card .entries { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.6; overflow-x: auto; white-space: pre; }
#card .chips { display: flex; gap: 6px; flex-wrap: wrap; }
#card .chip {
    font-size: 10.5px; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 20px; padding: 0 8px;
}
</style>
</head>
<body>
<div id="hint"><span>hover a node to trace its path &nbsp;&middot;&nbsp; click a node to jump &nbsp;&middot;&nbsp; Cmd/Ctrl + scroll to zoom &nbsp;&middot;&nbsp; Esc to close</span><span id="legend">${legend}</span></div>
<div id="wrap">${svgMarkup}<button id="parentsBtn" data-show="${!hasParents}" style="left:${buttonLeft}px; top:${buttonTop}px;">${buttonLabel}</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const wrap = document.getElementById('wrap');
let scale = 1;
window.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) { return; }
    event.preventDefault();
    scale = Math.min(3, Math.max(0.3, scale * (event.deltaY < 0 ? 1.1 : 0.9)));
    wrap.style.transform = 'scale(' + scale + ')';
}, { passive: false });
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { vscode.postMessage({ type: 'close' }); }
});
const parentsBtn = document.getElementById('parentsBtn');
parentsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    parentsBtn.disabled = true;
    parentsBtn.textContent = 'loading…';
    vscode.postMessage({ type: 'callers', shouldShow: parentsBtn.dataset.show === 'true' });
});

const svg = document.querySelector('svg');
const edgeByKey = new Map();
const edgesFromParent = new Map();
for (const path of document.querySelectorAll('path[data-from]')) {
    edgeByKey.set(path.dataset.from + '->' + path.dataset.to, path);
    const siblings = edgesFromParent.get(path.dataset.from) ?? [];
    siblings.push(path);
    edgesFromParent.set(path.dataset.from, siblings);
}
const nodeById = new Map();
for (const el of document.querySelectorAll('.fn-node')) {
    nodeById.set(el.dataset.nodeId, el);
}

function depthOf(el) {
    let depth = 0;
    let current = el;
    while (current && current.dataset.parentId) {
        depth += 1;
        current = nodeById.get(current.dataset.parentId);
    }
    return depth;
}

// tree edges from the hovered node up to the root, in execution order for the caller side
function chainToRoot(el) {
    const chain = [];
    let current = el;
    while (current && current.dataset.parentId) {
        const edge = edgeByKey.get(current.dataset.parentId + '->' + current.dataset.nodeId);
        if (!edge) { break; }
        chain.push(edge);
        current = nodeById.get(current.dataset.parentId);
    }
    return chain;
}

// all caller edges feeding into startEl, grouped so every branch arrives at the same time:
// edges at caller-depth d play at stage (maxDepth - d)
function callerFeedStages(startEl) {
    const groups = new Map();
    let maxDepth = 0;
    const startDepth = depthOf(startEl);
    const queue = [startEl];
    while (queue.length) {
        const current = queue.shift();
        for (const edge of edgesFromParent.get(current.dataset.nodeId) ?? []) {
            const child = nodeById.get(edge.dataset.to);
            if (!child || child.dataset.side !== 'caller') { continue; }
            const depth = depthOf(child);
            if (!groups.has(depth)) { groups.set(depth, []); }
            groups.get(depth).push(edge);
            maxDepth = Math.max(maxDepth, depth);
            queue.push(child);
        }
    }
    const stages = [];
    for (let depth = maxDepth; depth > startDepth; depth--) {
        stages.push(groups.get(depth) ?? []);
    }
    return stages;
}

const allEdges = [...document.querySelectorAll('path[data-from]')];
const allNodes = [...document.querySelectorAll('.fn-node')];
const DIM_NODE = 'opacity(0.35) saturate(0.5)';

let packets = [];
let rafId = 0;
let flowToken = 0;

function resetStyles() {
    for (const edge of allEdges) {
        edge.style.filter = '';
        edge.style.stroke = '';
        edge.style.strokeWidth = '';
        edge.setAttribute('marker-end', 'url(#arrow)');
    }
    for (const nodeEl of allNodes) { nodeEl.style.filter = ''; }
}

function stopFlow() {
    flowToken += 1;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    for (const packet of packets) { packet.circle.remove(); }
    packets = [];
    resetStyles();
}

function startFlow(el) {
    stopFlow();
    const token = flowToken;
    const rootEl = [...nodeById.values()].find((node) => !node.dataset.parentId);
    if (!rootEl) { return; }
    // flow always originates at the parents: caller branches converge into the root,
    // then a single packet continues along the path to the hovered callee
    let stages;
    if (el.dataset.side === 'caller') {
        stages = callerFeedStages(el);
        for (const edge of chainToRoot(el)) { stages.push([edge]); }
    } else if (el === rootEl) {
        stages = callerFeedStages(rootEl);
    } else {
        stages = callerFeedStages(rootEl);
        for (const edge of chainToRoot(el).reverse()) { stages.push([edge]); }
    }
    if (!stages.length) { return; }

    // color-grade the active path, dim everything else
    const activeEdges = new Set();
    for (const edges of stages) { for (const edge of edges) { activeEdges.add(edge); } }
    const activeNodeIds = new Set();
    for (const edge of activeEdges) {
        activeNodeIds.add(edge.dataset.from);
        activeNodeIds.add(edge.dataset.to);
    }
    for (const edge of allEdges) {
        if (activeEdges.has(edge)) {
            edge.style.stroke = edge.dataset.color;
            edge.style.strokeWidth = '2.2';
            edge.setAttribute('marker-end', 'url(#arrow-' + edge.dataset.cat + ')');
        } else {
            edge.style.filter = 'opacity(0.22)';
        }
    }
    for (const nodeEl of allNodes) {
        if (!activeNodeIds.has(nodeEl.dataset.nodeId)) {
            nodeEl.style.filter = DIM_NODE;
        }
    }
    const hoverGlow = 'drop-shadow(0 0 6px ' + (el.querySelector('rect')?.getAttribute('stroke') ?? '#8a939e') + ')';
    el.style.filter = hoverGlow;

    // a quick glow when a packet arrives at a node, eased back by the CSS transition
    const pulse = (nodeEl) => {
        if (!nodeEl) { return; }
        const color = nodeEl.querySelector('rect')?.getAttribute('stroke') ?? '#8a939e';
        nodeEl.style.filter = 'drop-shadow(0 0 9px ' + color + ')';
        setTimeout(() => {
            if (flowToken !== token) { return; }
            if (nodeEl === el) { nodeEl.style.filter = hoverGlow; }
            else { nodeEl.style.filter = activeNodeIds.has(nodeEl.dataset.nodeId) ? '' : DIM_NODE; }
        }, 240);
    };

    stages.forEach((edges, stage) => {
        for (const edge of edges) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('r', '3.2');
            circle.setAttribute('fill', edge.dataset.color);
            circle.setAttribute('opacity', '0');
            circle.style.filter = 'drop-shadow(0 0 3px ' + edge.dataset.color + ')';
            svg.appendChild(circle);
            packets.push({ edge, stage, circle, length: edge.getTotalLength() });
        }
    });

    const HOP_MS = 420;
    const PAUSE_MS = 350;
    const cycle = stages.length * HOP_MS + PAUSE_MS;
    // anchor to the first frame's timestamp: rAF timestamps can precede performance.now()
    let startTime = null;
    let lastStage = -1;
    const step = (now) => {
        if (startTime === null) { startTime = now; }
        const t = (now - startTime) % cycle;
        const stage = Math.floor(t / HOP_MS);
        if (stage !== lastStage) {
            for (const packet of packets) {
                if (packet.stage === lastStage) { pulse(nodeById.get(packet.edge.dataset.end)); }
            }
            lastStage = stage;
        }
        const fraction = (t - stage * HOP_MS) / HOP_MS;
        for (const packet of packets) {
            if (packet.stage === stage) {
                const point = packet.edge.getPointAtLength(fraction * packet.length);
                packet.circle.setAttribute('opacity', '0.95');
                packet.circle.setAttribute('cx', point.x);
                packet.circle.setAttribute('cy', point.y);
            } else {
                packet.circle.setAttribute('opacity', '0');
            }
        }
        rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
}

// ---------- hover details card ----------
const card = document.createElement('div');
card.id = 'card';
document.body.appendChild(card);
const cardCache = new Map();
let hoverEl = null;
let closeTimer = 0;
let intentTimer = 0;

const ROW_META = {
    in: { glyph: '→', color: '#58a6ff', label: 'in' },
    out: { glyph: '↩', color: '#57d364', label: 'out' },
    guards: { glyph: '▲', color: '#f47067', label: 'guards' },
    mutates: { glyph: 'Δ', color: '#e3b341', label: 'mutates' },
    callers: { glyph: '←', color: '#76e3ea', label: 'called by' },
    git: { glyph: '◷', color: '#8b949e', label: 'git' },
};

function requestDetails(el) {
    const nodeId = el.dataset.nodeId;
    if (cardCache.has(nodeId)) {
        renderCard(el, cardCache.get(nodeId));
        return;
    }
    const parentEl = el.dataset.parentId ? nodeById.get(el.dataset.parentId) : null;
    vscode.postMessage({
        type: 'details',
        uri: el.dataset.uri,
        line: Number(el.dataset.line),
        character: Number(el.dataset.character),
        nodeId,
        parentUri: parentEl ? parentEl.dataset.uri : undefined,
        parentLine: parentEl ? Number(parentEl.dataset.line) : undefined,
        parentCharacter: parentEl ? Number(parentEl.dataset.character) : undefined,
    });
}

window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'details') { return; }
    cardCache.set(message.nodeId, message.details);
    if (hoverEl && hoverEl.dataset.nodeId === message.nodeId) {
        renderCard(hoverEl, message.details);
    }
});

function block(parent, tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    parent.appendChild(node);
    return node;
}

function renderCard(el, details) {
    if (!details) { return; }
    card.textContent = '';
    const head = block(card, 'div', 'head');
    block(head, 'span', 'name', details.name);
    block(head, 'span', 'loc', details.location);
    block(card, 'div', 'code', details.signature);
    for (const group of details.groups) {
        const meta = ROW_META[group.kind];
        if (!meta) { continue; }
        const row = block(card, 'div', 'row');
        const glyph = block(row, 'span', 'glyph', meta.glyph);
        glyph.style.color = meta.color;
        block(row, 'span', 'rowlabel', meta.label);
        const entries = block(row, 'div', 'entries');
        for (const entry of group.entries) { block(entries, 'div', '', entry); }
    }
    const chips = block(card, 'div', 'chips');
    for (const fact of details.facts) { block(chips, 'span', 'chip', fact); }

    card.style.borderColor = el.querySelector('rect')?.getAttribute('stroke') ?? '';
    card.classList.add('open');
    const rect = el.getBoundingClientRect();
    const left = Math.max(
        8,
        Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - card.offsetWidth - 12)
    );
    card.style.left = left + 'px';
    card.style.top = (rect.bottom + window.scrollY + 10) + 'px';
}

function hideCard() {
    card.classList.remove('open');
}

function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
        hoverEl = null;
        stopFlow();
        hideCard();
    }, 160);
}
card.addEventListener('mouseenter', () => clearTimeout(closeTimer));
card.addEventListener('mouseleave', scheduleClose);

for (const el of document.querySelectorAll('.fn-node')) {
    el.addEventListener('click', () => {
        vscode.postMessage({
            type: 'open',
            uri: el.dataset.uri,
            line: Number(el.dataset.line),
            character: Number(el.dataset.character),
        });
    });
    el.addEventListener('mouseenter', () => {
        clearTimeout(closeTimer);
        clearTimeout(intentTimer);
        if (hoverEl !== el) {
            hideCard();
            startFlow(el);
            hoverEl = el;
        }
        intentTimer = setTimeout(() => {
            if (hoverEl === el) { requestDetails(el); }
        }, 250);
    });
    el.addEventListener('mouseleave', () => {
        clearTimeout(intentTimer);
        scheduleClose();
    });
}
</script>
</body>
</html>`;
}

// ---------- call tree ----------

interface CallNode {
    item: vscode.CallHierarchyItem;
    children: CallNode[];
}

interface NodeBudget {
    used: number;
    isExhausted: boolean;
}

async function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
): Promise<vscode.Hover | undefined> {
    let roots: vscode.CallHierarchyItem[] | undefined;
    try {
        roots = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            document.uri,
            position
        );
    } catch {
        return undefined;
    }
    const root = roots?.[0];
    if (!root || token.isCancellationRequested || isExternal(root)) {
        return undefined;
    }

    const isExpanded = expandedCallers.has(itemKey(root));
    const outBudget: NodeBudget = { used: 0, isExhausted: false };
    const inBudget: NodeBudget = { used: 0, isExhausted: false };
    const outTree = await buildTree(root, MAX_DEPTH, outBudget, new Set<string>(), token, 'outgoing');
    // parents are opt-in: only traced after the user clicks the callers button
    const inTree: CallNode = isExpanded
        ? await buildTree(root, MAX_DEPTH, inBudget, new Set<string>(), token, 'incoming')
        : { item: root, children: [] };

    const calleeGraph = toGraph(outTree, root.uri);
    const callerGraph = toGraph(inTree, root.uri);
    const externals = collectExternals(outTree);
    collectExternals(inTree, externals);

    const hasCallees = calleeGraph.children.length > 0;
    const hasCallers = callerGraph.children.length > 0;

    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = true;
    markdown.supportHtml = true;
    markdown.appendMarkdown(headerLine(root, isExpanded, document, position) + '\n\n');

    if (!hasCallees && !hasCallers) {
        const message = isExpanded
            ? 'makes no traced calls and has no workspace callers.'
            : externals.size
              ? 'calls only library code.'
              : 'makes no calls we can trace.';
        markdown.appendMarkdown(dim(message));
        return new vscode.Hover(markdown);
    }

    const svg = renderSvg(callerGraph, calleeGraph);
    const { displayWidth, displayHeight } = fitToHover(svg.width, svg.height);
    // the chart is an image, so nodes can't be individual click targets here;
    // clicking anywhere on it opens the interactive full-size view instead
    const image = `<img src="data:image/svg+xml,${encodeURIComponent(svg.markup)}" width="${displayWidth}" height="${displayHeight}">`;
    markdown.appendMarkdown(
        `[${image}](command:callCharts.expand?${expandCommandArgs(document, position)} "Open the interactive graph — click nodes there to jump")\n\n`
    );

    const footnotes: string[] = [];
    if (isExpanded && !hasCallers) {
        footnotes.push(dim('no workspace callers found'));
    }
    const legend = legendLine([callerGraph, calleeGraph]);
    if (legend) {
        footnotes.push(legend);
    }
    if (outBudget.isExhausted || inBudget.isExhausted) {
        footnotes.push(dim(`… truncated at ${MAX_NODES} calls per side`));
    }
    // one wrapping line instead of stacked lines: every saved row is chart space
    markdown.appendMarkdown(footnotes.join('&nbsp;&nbsp;&nbsp;&nbsp;'));
    return new vscode.Hover(markdown);
}

function headerLine(
    root: vscode.CallHierarchyItem,
    isExpanded: boolean,
    document: vscode.TextDocument,
    position: vscode.Position
): string {
    const args = encodeURIComponent(
        JSON.stringify([document.uri.toString(), position.line, position.character, itemKey(root), !isExpanded])
    );
    const title = isExpanded
        ? `$(type-hierarchy) **Flow through** \`${root.name}\``
        : `$(call-outgoing) **Flow of** \`${root.name}\``;
    const toggleLabel = isExpanded ? '$(chevron-left)&nbsp;hide callers' : '$(call-incoming)&nbsp;callers';
    const tooltip = isExpanded ? 'Hide who calls this' : 'Also trace where this function is called from';
    const expandLink = `[$(screen-full)&nbsp;expand](command:callCharts.expand?${expandCommandArgs(document, position)} "Open the complete graph full-size (click nodes to jump, Esc to close)")`;
    return `${title}&nbsp;&nbsp;&nbsp;[${toggleLabel}](command:callCharts.callers?${args} "${tooltip}")&nbsp;&nbsp;&nbsp;${expandLink}`;
}

function expandCommandArgs(document: vscode.TextDocument, position: vscode.Position): string {
    return encodeURIComponent(JSON.stringify([document.uri.toString(), position.line, position.character]));
}

async function buildTree(
    item: vscode.CallHierarchyItem,
    depth: number,
    budget: NodeBudget,
    visitedPath: Set<string>,
    token: vscode.CancellationToken,
    direction: Direction
): Promise<CallNode> {
    const node: CallNode = { item, children: [] };
    if (depth === 0 || budget.isExhausted || token.isCancellationRequested || isExternal(item)) {
        return node;
    }
    // path-based cycle guard: block recursion, allow the same fn in sibling branches
    const key = itemKey(item);
    if (visitedPath.has(key)) {
        return node;
    }
    visitedPath.add(key);

    const related = await fetchRelated(item, direction);
    const seenChildren = new Set<string>();
    for (const relatedItem of related) {
        const childKey = itemKey(relatedItem);
        if (seenChildren.has(childKey)) {
            continue;
        }
        seenChildren.add(childKey);
        if (isExternal(relatedItem)) {
            node.children.push({ item: relatedItem, children: [] });
            continue;
        }
        if (budget.used >= MAX_NODES) {
            budget.isExhausted = true;
            break;
        }
        budget.used += 1;
        node.children.push(await buildTree(relatedItem, depth - 1, budget, visitedPath, token, direction));
    }
    visitedPath.delete(key);
    return node;
}

async function fetchRelated(item: vscode.CallHierarchyItem, direction: Direction): Promise<vscode.CallHierarchyItem[]> {
    try {
        if (direction === 'outgoing') {
            const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                'vscode.provideOutgoingCalls',
                item
            );
            return [...(calls ?? [])]
                .sort((a, b) => (a.fromRanges[0]?.start.line ?? 0) - (b.fromRanges[0]?.start.line ?? 0))
                .map((call) => call.to);
        }
        const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
            'vscode.provideIncomingCalls',
            item
        );
        return [...(calls ?? [])]
            .sort((a, b) => (a.fromRanges[0]?.start.line ?? 0) - (b.fromRanges[0]?.start.line ?? 0))
            .map((call) => call.from);
    } catch {
        return [];
    }
}

function itemKey(item: vscode.CallHierarchyItem): string {
    return `${item.uri.toString()}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
}

function isExternal(item: vscode.CallHierarchyItem): boolean {
    const path = item.uri.path;
    return item.uri.scheme !== 'file' || path.includes('/node_modules/') || path.endsWith('.d.ts');
}

function externalPackage(item: vscode.CallHierarchyItem): string {
    const packageMatch = item.uri.path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
    const name = packageMatch?.[1] ?? item.uri.path.split('/').pop() ?? '';
    if (name === 'typescript' || name.startsWith('lib.')) {
        return 'js';
    }
    return name;
}

function collectExternals(node: CallNode, groups = new Map<string, string[]>()): Map<string, string[]> {
    for (const child of node.children) {
        if (isExternal(child.item)) {
            const pkg = externalPackage(child.item);
            const names = groups.get(pkg) ?? [];
            if (!names.includes(child.item.name)) {
                names.push(child.item.name);
            }
            groups.set(pkg, names);
        } else {
            collectExternals(child, groups);
        }
    }
    return groups;
}

// ---------- graph model & layout ----------

type Category = 'component' | 'service' | 'data' | 'util' | 'other';

interface GraphNode {
    item: vscode.CallHierarchyItem;
    children: GraphNode[];
    label: string;
    subtitle: string;
    category: Category;
    depth: number;
    x: number;
    yCenter: number;
    width: number;
}

const FONT_SIZE = 12;
const SUB_FONT_SIZE = 9.5;
const NODE_HEIGHT = 30;
const VERTICAL_GAP = 12;
const COLUMN_GAP = 48;
const PADDING_X = 10;
const MARGIN = 8;
const MAX_LABEL_CHARS = 26;

function toGraph(node: CallNode, parentUri: vscode.Uri, depth = 0): GraphNode {
    const children = node.children
        .filter((child) => !isExternal(child.item))
        .map((child) => toGraph(child, node.item.uri, depth + 1));
    const label = truncate(node.item.name, MAX_LABEL_CHARS);
    const subtitle = node.item.uri.path === parentUri.path || depth === 0 ? '' : basename(node.item.uri);
    return {
        item: node.item,
        children,
        label,
        subtitle: truncate(subtitle, MAX_LABEL_CHARS + 6),
        category: categorize(basename(node.item.uri)),
        depth,
        x: 0,
        yCenter: 0,
        width: nodeWidth(label, subtitle),
    };
}

function categorize(fileName: string): Category {
    if (fileName.includes('.component.')) {
        return 'component';
    }
    if (fileName.includes('.service.')) {
        return 'service';
    }
    if (/database|repository|\.effects\.|\.reducer\.|\.store\.|schema|model/.test(fileName)) {
        return 'data';
    }
    if (/util|helper|shared|common/.test(fileName)) {
        return 'util';
    }
    return 'other';
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textWidth(text: string, fontSize: number): number {
    return text.length * fontSize * 0.62;
}

function nodeWidth(label: string, subtitle: string): number {
    const inner = Math.max(textWidth(label, FONT_SIZE), textWidth(subtitle, SUB_FONT_SIZE));
    return Math.max(72, Math.ceil(inner) + PADDING_X * 2);
}

interface LayoutResult {
    all: GraphNode[];
    width: number;
    height: number;
}

function layout(root: GraphNode): LayoutResult {
    const all: GraphNode[] = [];
    const collect = (node: GraphNode): void => {
        all.push(node);
        node.children.forEach(collect);
    };
    collect(root);

    const columnWidths: number[] = [];
    for (const node of all) {
        columnWidths[node.depth] = Math.max(columnWidths[node.depth] ?? 0, node.width);
    }
    const columnX: number[] = [];
    let x = MARGIN;
    columnWidths.forEach((width, depth) => {
        columnX[depth] = x;
        x += width + COLUMN_GAP;
    });

    let cursor = MARGIN;
    const assignY = (node: GraphNode): void => {
        node.x = columnX[node.depth];
        if (!node.children.length) {
            node.yCenter = cursor + NODE_HEIGHT / 2;
            cursor += NODE_HEIGHT + VERTICAL_GAP;
            return;
        }
        node.children.forEach(assignY);
        node.yCenter = (node.children[0].yCenter + node.children[node.children.length - 1].yCenter) / 2;
    };
    assignY(root);

    return {
        all,
        width: x - COLUMN_GAP + MARGIN,
        height: cursor - VERTICAL_GAP + MARGIN,
    };
}

// ---------- svg rendering ----------

const CATEGORY_COLORS: Record<Category, string> = {
    component: '#4d8edb',
    service: '#9d7cd8',
    data: '#d9a35a',
    util: '#5fb8a5',
    other: '#8a939e',
};

const CATEGORY_LABELS: Record<Category, string> = {
    component: 'component',
    service: 'service',
    data: 'data/store',
    util: 'util',
    other: 'other',
};

// scale the vector chart down to fit the hover viewport; below minScale readability
// loses to size, so we stop shrinking and let the hover scroll instead
function fitToHover(width: number, height: number): { displayWidth: number; displayHeight: number } {
    const config = vscode.workspace.getConfiguration('callCharts');
    const maxWidth = config.get<number>('maxWidth', 820);
    const maxHeight = config.get<number>('maxHeight', 380);
    const minScale = config.get<number>('minScale', 0.5);
    const scale = Math.max(Math.min(1, maxWidth / width, maxHeight / height), minScale);
    return {
        displayWidth: Math.round(width * scale),
        displayHeight: Math.round(height * scale),
    };
}

const REVEAL_STEP_SECONDS = 0.12;
const PACKET_STAGE_SECONDS = 0.5;
const PACKET_PAUSE_SECONDS = 0.6;

interface SvgTheme {
    isDark: boolean;
    textColor: string;
    subColor: string;
    edgeColor: string;
    shouldAnimate: boolean;
    isInteractive: boolean;
    totalStages: number;
}

// butterfly chart: callers mirrored on the left, callees on the right, hovered fn shared in the middle
function renderSvg(
    callerRoot: GraphNode,
    calleeRoot: GraphNode,
    isInteractive = false
): { markup: string; width: number; height: number } {
    const isDark =
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
    const shouldAnimate = vscode.workspace.getConfiguration('callCharts').get<boolean>('animation', true);

    const calleeSide = layout(calleeRoot);
    const callerSide = layout(callerRoot);
    for (const node of callerSide.all) {
        node.x = callerSide.width - node.x - node.width;
    }
    const shiftX = callerSide.width - 2 * MARGIN - calleeRoot.width;
    for (const node of calleeSide.all) {
        node.x += shiftX;
    }
    const rootY = Math.max(calleeRoot.yCenter, callerRoot.yCenter);
    const calleeShiftY = rootY - calleeRoot.yCenter;
    const callerShiftY = rootY - callerRoot.yCenter;
    for (const node of calleeSide.all) {
        node.yCenter += calleeShiftY;
    }
    for (const node of callerSide.all) {
        node.yCenter += callerShiftY;
    }
    const width = shiftX + calleeSide.width;
    let height = Math.max(calleeSide.height + calleeShiftY, callerSide.height + callerShiftY);
    if (isInteractive) {
        // headroom for the you-are-here marker, footroom for the parents button
        for (const node of callerSide.all) {
            node.yCenter += 28;
        }
        for (const node of calleeSide.all) {
            node.yCenter += 28;
        }
        height += 56;
    }

    const callerDepth = Math.max(...callerSide.all.map((node) => node.depth));
    const calleeDepth = Math.max(...calleeSide.all.map((node) => node.depth));
    const theme: SvgTheme = {
        isDark,
        textColor: isDark ? '#e6edf3' : '#24292f',
        subColor: isDark ? '#8b949e' : '#6e7781',
        edgeColor: isDark ? '#6e7681' : '#a5adb6',
        shouldAnimate,
        isInteractive,
        totalStages: callerDepth + calleeDepth,
    };

    const parts: string[] = [];
    parts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">`
    );
    const marker = (id: string, fill: string): string =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">` +
        `<path d="M 0 1 L 9 5 L 0 9 z" fill="${fill}"/></marker>`;
    const markers = [marker('arrow', theme.edgeColor)];
    if (isInteractive) {
        // colored arrowheads for the active-path highlight in the expand view
        for (const [category, color] of Object.entries(CATEGORY_COLORS)) {
            markers.push(marker(`arrow-${category}`, color));
        }
    }
    parts.push(`<defs>${markers.join('')}</defs>`);
    if (shouldAnimate) {
        parts.push(
            '<style>' +
                '.node{opacity:0;animation:nodeIn .28s ease-out forwards;}' +
                '@keyframes nodeIn{from{opacity:0;transform:translateX(-9px);}to{opacity:1;transform:none;}}' +
                '.edge{opacity:0;animation:edgeIn .3s ease-out forwards;}' +
                '@keyframes edgeIn{to{opacity:1;}}' +
                '</style>'
        );
    }

    // node ids + tree parent links let the expand view trace a hovered node's call path
    const nodeIds = new Map<GraphNode, string>();
    const parentOf = new Map<GraphNode, GraphNode>();
    if (isInteractive) {
        calleeSide.all.forEach((node, index) => nodeIds.set(node, `n${index}`));
        callerSide.all.forEach((node, index) => nodeIds.set(node, node.depth === 0 ? 'n0' : `c${index}`));
        for (const side of [callerSide.all, calleeSide.all]) {
            for (const node of side) {
                for (const child of node.children) {
                    parentOf.set(child, node);
                }
            }
        }
    }
    const metaFor = (node: GraphNode, side: 'caller' | 'callee'): InteractiveNodeMeta | undefined => {
        if (!isInteractive) {
            return undefined;
        }
        const parent = parentOf.get(node);
        return {
            id: nodeIds.get(node) ?? '',
            parentId: parent ? nodeIds.get(parent) : undefined,
            side,
        };
    };

    // execution enters from the outermost callers (stage 0), reaches the hovered fn,
    // then continues into callees — stages number the hops of that journey
    for (const node of callerSide.all) {
        for (const child of node.children) {
            renderEdge(parts, child, node, callerDepth - child.depth, theme, {
                fromId: nodeIds.get(node),
                toId: nodeIds.get(child),
                endId: nodeIds.get(node),
            });
        }
    }
    for (const node of calleeSide.all) {
        for (const child of node.children) {
            renderEdge(parts, node, child, callerDepth + node.depth, theme, {
                fromId: nodeIds.get(node),
                toId: nodeIds.get(child),
                endId: nodeIds.get(child),
            });
        }
    }

    for (const node of callerSide.all) {
        if (node.depth === 0) {
            continue; // the shared root is drawn once, from the callee side
        }
        renderNode(parts, node, callerDepth - node.depth, theme, metaFor(node, 'caller'));
    }
    for (const node of calleeSide.all) {
        renderNode(parts, node, callerDepth + node.depth, theme, metaFor(node, 'callee'));
    }

    if (isInteractive) {
        // the opened function gets an explicit marker so it reads at a glance
        const centerX = calleeRoot.x + calleeRoot.width / 2;
        const rootTop = calleeRoot.yCenter - NODE_HEIGHT / 2;
        parts.push(
            `<text x="${centerX}" y="${rootTop - 19}" font-size="9" fill="${theme.subColor}" ` +
                `text-anchor="middle" letter-spacing="0.5">you are here</text>`
        );
        parts.push(
            `<polygon points="${centerX - 6},${rootTop - 15} ${centerX + 6},${rootTop - 15} ${centerX},${rootTop - 5}" ` +
                `fill="${CATEGORY_COLORS[calleeRoot.category]}"/>`
        );
    }

    parts.push('</svg>');
    return { markup: parts.join(''), width, height };
}

interface InteractiveNodeMeta {
    id: string;
    parentId?: string;
    side: 'caller' | 'callee';
}

interface EdgeIds {
    fromId?: string;
    toId?: string;
    endId?: string;
}

function renderEdge(
    parts: string[],
    start: GraphNode,
    end: GraphNode,
    stage: number,
    theme: SvgTheme,
    ids?: EdgeIds
): void {
    const x1 = start.x + start.width;
    const y1 = start.yCenter;
    const x2 = end.x - 2;
    const y2 = end.yCenter;
    const bend = (x2 - x1) / 2;
    const edgePath = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    const animatedClass = theme.shouldAnimate
        ? ` class="edge" style="animation-delay:${((stage + 1) * REVEAL_STEP_SECONDS).toFixed(2)}s"`
        : '';
    const dataAttrs =
        theme.isInteractive && ids?.fromId && ids.toId
            ? ` data-from="${ids.fromId}" data-to="${ids.toId}" data-end="${ids.endId ?? ''}" ` +
              `data-cat="${end.category}" data-color="${CATEGORY_COLORS[end.category]}"`
            : '';
    parts.push(
        `<path d="${edgePath}" fill="none" stroke="${theme.edgeColor}" stroke-width="1.4" ` +
            `marker-end="url(#arrow)"${animatedClass}${dataAttrs}/>`
    );
    // expand view: packets only run on demand along the hovered node's path (webview script)
    if (!theme.shouldAnimate || theme.isInteractive) {
        return;
    }
    // one packet per edge, but timed so the wave traverses the chart hop by hop:
    // each packet is only visible (and moving) during its own stage of the cycle
    const cycle = theme.totalStages * PACKET_STAGE_SECONDS + PACKET_PAUSE_SECONDS;
    const t0 = Math.max((stage * PACKET_STAGE_SECONDS) / cycle, 0.001);
    const t1 = ((stage + 1) * PACKET_STAGE_SECONDS) / cycle;
    const eps = 0.01;
    parts.push(
        `<circle r="2.6" fill="${CATEGORY_COLORS[end.category]}" opacity="0">` +
            `<animateMotion dur="${cycle.toFixed(2)}s" repeatCount="indefinite" calcMode="linear" ` +
            `keyPoints="0;0;1;1" keyTimes="0;${t0.toFixed(4)};${t1.toFixed(4)};1" path="${edgePath}"/>` +
            `<animate attributeName="opacity" dur="${cycle.toFixed(2)}s" repeatCount="indefinite" ` +
            `values="0;0;0.9;0.9;0;0" keyTimes="0;${t0.toFixed(4)};${(t0 + eps).toFixed(4)};${(t1 - eps).toFixed(4)};${t1.toFixed(4)};1"/>` +
            `</circle>`
    );
}

function renderNode(
    parts: string[],
    node: GraphNode,
    stage: number,
    theme: SvgTheme,
    meta?: InteractiveNodeMeta
): void {
    const color = CATEGORY_COLORS[node.category];
    const top = node.yCenter - NODE_HEIGHT / 2;
    const isRoot = node.depth === 0;
    const classes: string[] = [];
    if (theme.shouldAnimate) {
        classes.push('node');
    }
    if (theme.isInteractive) {
        classes.push('fn-node');
    }
    const classAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
    const styleAttr = theme.shouldAnimate
        ? ` style="animation-delay:${(stage * REVEAL_STEP_SECONDS).toFixed(2)}s"`
        : '';
    const dataAttrs =
        theme.isInteractive && meta
            ? ` data-uri="${escapeXml(node.item.uri.toString())}" data-line="${node.item.selectionRange.start.line}" ` +
              `data-character="${node.item.selectionRange.start.character}" data-node-id="${meta.id}"` +
              `${meta.parentId ? ` data-parent-id="${meta.parentId}"` : ''} data-side="${meta.side}"`
            : '';
    parts.push(`<g${classAttr}${styleAttr}${dataAttrs}>`);
    parts.push(
        `<rect x="${node.x}" y="${top}" width="${node.width}" height="${NODE_HEIGHT}" rx="7" ` +
            `fill="${color}" fill-opacity="${theme.isDark ? 0.16 : 0.12}" stroke="${color}" stroke-width="${isRoot ? 2.2 : 1.3}"/>`
    );
    const hasSubtitle = node.subtitle.length > 0;
    const labelY = hasSubtitle ? node.yCenter - 2.5 : node.yCenter + 4;
    parts.push(
        `<text x="${node.x + PADDING_X}" y="${labelY}" font-size="${FONT_SIZE}" ` +
            `font-weight="${isRoot ? 700 : 500}" fill="${theme.textColor}">${escapeXml(node.label)}</text>`
    );
    if (hasSubtitle) {
        parts.push(
            `<text x="${node.x + PADDING_X}" y="${node.yCenter + 10}" font-size="${SUB_FONT_SIZE}" ` +
                `fill="${theme.subColor}">${escapeXml(node.subtitle)}</text>`
        );
    }
    parts.push('</g>');
}

function escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- markdown footnotes ----------

function walkGraph(node: GraphNode, visit: (node: GraphNode) => void): void {
    visit(node);
    node.children.forEach((child) => walkGraph(child, visit));
}

function legendLine(roots: GraphNode[]): string {
    const present = new Set<Category>();
    roots.forEach((root) => walkGraph(root, (node) => present.add(node.category)));
    if (present.size < 2) {
        return '';
    }
    const entries = (Object.keys(CATEGORY_COLORS) as Category[])
        .filter((category) => present.has(category))
        .map(
            (category) =>
                `<span style="color:${CATEGORY_COLORS[category]};">■</span>&nbsp;${dim(CATEGORY_LABELS[category])}`
        );
    return entries.join('&nbsp;&nbsp;');
}

function dim(text: string): string {
    return `<span style="color:var(--vscode-descriptionForeground);">${text}</span>`;
}

function basename(uri: vscode.Uri): string {
    return uri.path.split('/').pop() ?? '';
}
