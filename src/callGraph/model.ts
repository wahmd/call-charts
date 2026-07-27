import * as vscode from 'vscode';
import { CallNode, isExternal } from './build';
import { basename, truncate } from '../util';

export type Category = 'component' | 'service' | 'data' | 'util' | 'other';

export interface GraphNode {
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

export const CATEGORY_COLORS: Record<Category, string> = {
    component: '#4d8edb',
    service: '#9d7cd8',
    data: '#d9a35a',
    util: '#5fb8a5',
    other: '#8a939e',
};

export const CATEGORY_LABELS: Record<Category, string> = {
    component: 'component',
    service: 'service',
    data: 'data/store',
    util: 'util',
    other: 'other',
};

export const FONT_SIZE = 12;
export const SUB_FONT_SIZE = 9.5;
export const NODE_HEIGHT = 30;
export const VERTICAL_GAP = 12;
export const COLUMN_GAP = 48;
export const PADDING_X = 10;
export const MARGIN = 8;

const MAX_LABEL_CHARS = 26;

export function toGraph(node: CallNode, parentUri: vscode.Uri, depth = 0): GraphNode {
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

export function walkGraph(node: GraphNode, visit: (node: GraphNode) => void): void {
    visit(node);
    node.children.forEach((child) => walkGraph(child, visit));
}

export function categoriesPresent(roots: GraphNode[]): Category[] {
    const present = new Set<Category>();
    roots.forEach((root) => walkGraph(root, (node) => present.add(node.category)));
    return (Object.keys(CATEGORY_COLORS) as Category[]).filter((category) => present.has(category));
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

function textWidth(text: string, fontSize: number): number {
    return text.length * fontSize * 0.62;
}

function nodeWidth(label: string, subtitle: string): number {
    const inner = Math.max(textWidth(label, FONT_SIZE), textWidth(subtitle, SUB_FONT_SIZE));
    return Math.max(72, Math.ceil(inner) + PADDING_X * 2);
}
