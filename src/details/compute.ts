import * as vscode from 'vscode';
import { isExternal, prepareCallHierarchyItem } from '../callGraph/build';
import { basename, truncate, tryCommand } from '../util';
import { countParams, extractGuards, extractMutations, extractReturns, extractSignature } from './extractors';
import { gitSummary } from './git';

export interface DetailGroup {
    kind: 'in' | 'out' | 'guards' | 'mutates' | 'callers' | 'git';
    entries: string[];
}

export interface NodeDetails {
    name: string;
    location: string;
    signature: string;
    groups: DetailGroup[];
    facts: string[];
}

export interface ParentRef {
    uri: string;
    line: number;
    character: number;
}

const cache = new Map<string, NodeDetails | undefined>();

export function clearDetailsCache(): void {
    cache.clear();
}

export async function computeNodeDetails(
    uriString: string,
    line: number,
    character: number,
    parent?: ParentRef
): Promise<NodeDetails | undefined> {
    const cacheKey = `${uriString}:${line}:${character}:${parent ? `${parent.uri}:${parent.line}` : ''}`;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }
    const uri = vscode.Uri.parse(uriString);
    const item = await prepareCallHierarchyItem(uri, new vscode.Position(line, character));
    if (!item) {
        cache.set(cacheKey, undefined);
        return undefined;
    }
    const document = await vscode.workspace.openTextDocument(uri);

    const signature = extractSignature(document, item);
    const lineCount = item.range.end.line - item.range.start.line + 1;
    const groups: DetailGroup[] = [];

    const incoming = (await tryCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item)) ?? [];

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
    const outgoing = await tryCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item);
    const workspaceCallCount = (outgoing ?? []).filter((call) => !isExternal(call.to)).length;
    if (lineCount <= 6 && workspaceCallCount === 1) {
        facts.push('pass-through');
    }

    const details: NodeDetails = {
        name: item.name,
        location: `${basename(uri)}:${item.selectionRange.start.line + 1}`,
        signature,
        groups,
        facts,
    };
    cache.set(cacheKey, details);
    return details;
}
