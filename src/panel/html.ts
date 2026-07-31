import * as crypto from 'crypto';
import { NODE_HEIGHT } from '../callGraph/model';
import { RootAnchor } from '../callGraph/svg';

export interface FlowPanelView {
    svgMarkup: string;
    legend: string;
    anchor: RootAnchor;
    hasParents: boolean;
    styleUri: string;
    scriptUri: string;
    cspSource: string;
}

// the page shell: static styles and behavior ship as media/ assets; everything dynamic
// (the chart, legend, parents button) is data rendered into the body here
export function flowPanelHtml(view: FlowPanelView): string {
    const buttonLeft = Math.round(view.anchor.x + view.anchor.width / 2);
    const buttonTop = Math.round(view.anchor.yCenter + NODE_HEIGHT / 2 + 9);
    const buttonLabel = view.hasParents ? '× hide parents' : '⟨ show parents';
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${view.styleUri}">
</head>
<body>
<div id="hint"><span>hover a node to trace its path &nbsp;&middot;&nbsp; click a node to jump &nbsp;&middot;&nbsp; Cmd/Ctrl + scroll to zoom &nbsp;&middot;&nbsp; Esc to close</span><span id="legend">${view.legend}</span></div>
<div id="wrap">${view.svgMarkup}<button id="parentsBtn" data-show="${!view.hasParents}" style="left:${buttonLeft}px; top:${buttonTop}px;">${buttonLabel}</button></div>
<script nonce="${nonce}" src="${view.scriptUri}"></script>
</body>
</html>`;
}
