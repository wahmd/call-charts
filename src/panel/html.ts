import { RootAnchor } from '../callGraph/svg';

// NOTE: the webview page currently lives in this template string; PR 3 extracts it
// into real JS/CSS asset files with a shared message protocol.
export function flowPanelHtml(svgMarkup: string, legend: string, anchor: RootAnchor, hasParents: boolean): string {
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
