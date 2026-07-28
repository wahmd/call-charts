# Changelog

## 0.6.1

- Marketplace listing icon.

## 0.6.0

- Renamed the extension from Hover Call Graph to **Call Charts**. Command ids and settings moved from
  `hoverCallGraph.*` to `callCharts.*` (settings need to be re-applied if you had customized them).
- Added lint/format tooling (ESLint, Prettier), npm scripts for packaging and local install, and this changelog.

## 0.5.0

- Expand view opens with callees only; a "show parents" button under the current function loads the caller side.
- "You are here" marker above the opened function.

## 0.4.0

- Hover details card rebuilt around symbol-coded rows: in (call-site arguments), out (returns), guards
  (early exits), mutates (`this.*` writes), called by (caller names), git (last commit touching the function).
- Layer-color legend in the expand view's hint bar.

## 0.3.0

- Details card on node hover in the expand view: signature, steps, fact chips (deterministic extraction, no AI).

## 0.2.0

- Active-path color grading in the expand view: path edges take their layer color with colored arrowheads,
  everything off-path dims; arrival pulses when packets reach a node.

## 0.1.x

- Interactive expand view (webview): full-size chart, clickable nodes, zoom, Esc to close.
- Hover-node path tracing: packets flow from the outermost callers through the function to the hovered node.
- Butterfly layout: callers left, callees right, shared root.

## 0.0.x

- Hover tooltip call chart rendered as an SVG data URI: layered layout, layer colors by file type,
  external-library calls collapsed, fit-to-hover scaling, staggered reveal and flow-packet animation.
