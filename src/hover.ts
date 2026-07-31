import * as vscode from 'vscode';
import {
    buildTree,
    CallNode,
    collectExternals,
    isExternal,
    itemKey,
    MAX_DEPTH,
    MAX_NODES,
    NodeBudget,
    prepareCallHierarchyItem,
} from './callGraph/build';
import { categoriesPresent, CATEGORY_COLORS, CATEGORY_LABELS, GraphNode, toGraph } from './callGraph/model';
import { fitToHover, renderSvg } from './callGraph/svg';

export const LANGUAGES = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];

// functions whose hover the user expanded with the callers button
const expandedCallers = new Set<string>();

export async function toggleCallers(
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

export async function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
): Promise<vscode.Hover | undefined> {
    const root = await prepareCallHierarchyItem(document.uri, position);
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

function legendLine(roots: GraphNode[]): string {
    const categories = categoriesPresent(roots);
    if (categories.length < 2) {
        return '';
    }
    return categories
        .map(
            (category) =>
                `<span style="color:${CATEGORY_COLORS[category]};">■</span>&nbsp;${dim(CATEGORY_LABELS[category])}`
        )
        .join('&nbsp;&nbsp;');
}

function dim(text: string): string {
    return `<span style="color:var(--vscode-descriptionForeground);">${text}</span>`;
}
