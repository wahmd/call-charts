import * as vscode from 'vscode';
import { truncate } from '../util';

// the declaration as written in source, from the range start down to the body brace
export function extractSignature(document: vscode.TextDocument, item: vscode.CallHierarchyItem): string {
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

export function countParams(signature: string): number | undefined {
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
export function extractGuards(
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
export function extractReturns(
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
export function extractMutations(document: vscode.TextDocument, item: vscode.CallHierarchyItem): string[] {
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
