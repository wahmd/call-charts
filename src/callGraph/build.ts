import * as vscode from 'vscode';
import { tryCommand } from '../util';

export const MAX_DEPTH = 3;
export const MAX_NODES = 40;

export type Direction = 'outgoing' | 'incoming';

export interface CallNode {
    item: vscode.CallHierarchyItem;
    children: CallNode[];
}

export interface NodeBudget {
    used: number;
    isExhausted: boolean;
}

// silent on failure: prepare is called on every hover and routinely rejects non-function symbols
export async function prepareCallHierarchyItem(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<vscode.CallHierarchyItem | undefined> {
    try {
        const roots = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            uri,
            position
        );
        return roots?.[0];
    } catch {
        return undefined;
    }
}

export async function buildTree(
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
    if (direction === 'outgoing') {
        const calls = await tryCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item);
        return [...(calls ?? [])]
            .sort((a, b) => (a.fromRanges[0]?.start.line ?? 0) - (b.fromRanges[0]?.start.line ?? 0))
            .map((call) => call.to);
    }
    const calls = await tryCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item);
    return [...(calls ?? [])]
        .sort((a, b) => (a.fromRanges[0]?.start.line ?? 0) - (b.fromRanges[0]?.start.line ?? 0))
        .map((call) => call.from);
}

export function itemKey(item: vscode.CallHierarchyItem): string {
    return `${item.uri.toString()}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
}

export function isExternal(item: vscode.CallHierarchyItem): boolean {
    const path = item.uri.path;
    return item.uri.scheme !== 'file' || path.includes('/node_modules/') || path.endsWith('.d.ts');
}

export function externalPackage(item: vscode.CallHierarchyItem): string {
    const packageMatch = item.uri.path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
    const name = packageMatch?.[1] ?? item.uri.path.split('/').pop() ?? '';
    if (name === 'typescript' || name.startsWith('lib.')) {
        return 'js';
    }
    return name;
}

export function collectExternals(node: CallNode, groups = new Map<string, string[]>()): Map<string, string[]> {
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
