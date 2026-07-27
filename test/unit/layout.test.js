require('../helpers/hook');
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkItem } = require('../helpers/fixtures');
const { layout } = require('../../out/callGraph/layout.js');
const { toGraph, NODE_HEIGHT } = require('../../out/callGraph/model.js');

function sampleGraph() {
    const root = mkItem('root', 'a.service.ts');
    const tree = {
        item: root,
        children: [
            {
                item: mkItem('branch', 'a.service.ts'),
                children: [
                    { item: mkItem('leafOne', 'a-database.ts'), children: [] },
                    { item: mkItem('leafTwo', 'a-database.ts'), children: [] },
                ],
            },
            { item: mkItem('leafThree', 'b.service.ts'), children: [] },
        ],
    };
    return toGraph(tree, root.uri);
}

test('leaves stack vertically without overlap', () => {
    const graph = sampleGraph();
    layout(graph);
    const leaves = [graph.children[0].children[0], graph.children[0].children[1], graph.children[1]];
    for (let i = 1; i < leaves.length; i++) {
        assert.ok(
            leaves[i].yCenter - leaves[i - 1].yCenter >= NODE_HEIGHT,
            `leaf ${i} overlaps its predecessor (${leaves[i - 1].yCenter} -> ${leaves[i].yCenter})`
        );
    }
});

test('a parent centers on its children', () => {
    const graph = sampleGraph();
    layout(graph);
    const branch = graph.children[0];
    const expected = (branch.children[0].yCenter + branch.children[1].yCenter) / 2;
    assert.equal(branch.yCenter, expected);
});

test('columns advance left to right by depth', () => {
    const graph = sampleGraph();
    layout(graph);
    assert.ok(graph.children[0].x > graph.x);
    assert.ok(graph.children[0].children[0].x > graph.children[0].x);
    assert.equal(graph.children[0].x, graph.children[1].x, 'same-depth nodes share a column');
});

test('reported size covers every node', () => {
    const graph = sampleGraph();
    const { all, width, height } = layout(graph);
    for (const node of all) {
        assert.ok(node.x + node.width <= width, `node ${node.label} exceeds width`);
        assert.ok(node.yCenter + NODE_HEIGHT / 2 <= height, `node ${node.label} exceeds height`);
    }
});
