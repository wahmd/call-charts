import { COLUMN_GAP, GraphNode, MARGIN, NODE_HEIGHT, VERTICAL_GAP } from './model';

export interface LayoutResult {
    all: GraphNode[];
    width: number;
    height: number;
}

// tidy tree: leaves stack evenly, parents center on their children, columns by depth
export function layout(root: GraphNode): LayoutResult {
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
