import * as vscode from 'vscode';
import { escapeXml } from '../util';
import { layout } from './layout';
import { CATEGORY_COLORS, FONT_SIZE, GraphNode, MARGIN, NODE_HEIGHT, PADDING_X, SUB_FONT_SIZE } from './model';

const REVEAL_STEP_SECONDS = 0.12;
const PACKET_STAGE_SECONDS = 0.5;
const PACKET_PAUSE_SECONDS = 0.6;
// extra vertical room in the expand view for the you-are-here marker and the parents button
const INTERACTIVE_HEADROOM = 28;

export interface RootAnchor {
    x: number;
    yCenter: number;
    width: number;
}

export interface RenderedSvg {
    markup: string;
    width: number;
    height: number;
    rootAnchor: RootAnchor;
}

interface SvgTheme {
    isDark: boolean;
    textColor: string;
    subColor: string;
    edgeColor: string;
    shouldAnimate: boolean;
    isInteractive: boolean;
    totalStages: number;
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

// scale the vector chart down to fit the hover viewport; below minScale readability
// loses to size, so we stop shrinking and let the hover scroll instead
export function fitToHover(width: number, height: number): { displayWidth: number; displayHeight: number } {
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

// butterfly chart: callers mirrored on the left, callees on the right, hovered fn shared in the middle
export function renderSvg(callerRoot: GraphNode, calleeRoot: GraphNode, isInteractive = false): RenderedSvg {
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
        for (const node of callerSide.all) {
            node.yCenter += INTERACTIVE_HEADROOM;
        }
        for (const node of calleeSide.all) {
            node.yCenter += INTERACTIVE_HEADROOM;
        }
        height += INTERACTIVE_HEADROOM * 2;
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
    return {
        markup: parts.join(''),
        width,
        height,
        // computed here so callers never depend on the positions this render assigned
        rootAnchor: { x: calleeRoot.x, yCenter: calleeRoot.yCenter, width: calleeRoot.width },
    };
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
