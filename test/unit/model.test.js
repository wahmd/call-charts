require('../helpers/hook');
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkItem } = require('../helpers/fixtures');
const { toGraph, categoriesPresent } = require('../../out/callGraph/model.js');

test('toGraph: layer category comes from the filename', () => {
    const cases = [
        ['user.component.ts', 'component'],
        ['user.service.ts', 'service'],
        ['user-database.ts', 'data'],
        ['date.helper.ts', 'util'],
        ['user.controller.ts', 'other'],
    ];
    for (const [file, expected] of cases) {
        const item = mkItem('fn', file);
        const graph = toGraph({ item, children: [] }, item.uri);
        assert.equal(graph.category, expected, file);
    }
});

test('toGraph: subtitle appears only when the call crosses files', () => {
    const root = mkItem('root', 'a.service.ts');
    const tree = {
        item: root,
        children: [
            { item: mkItem('sameFile', 'a.service.ts'), children: [] },
            { item: mkItem('crossFile', 'b.service.ts'), children: [] },
        ],
    };
    const graph = toGraph(tree, root.uri);
    assert.equal(graph.subtitle, '', 'root never shows a subtitle');
    assert.equal(graph.children[0].subtitle, '');
    assert.equal(graph.children[1].subtitle, 'b.service.ts');
});

test('toGraph: library children are excluded from the chart', () => {
    const root = mkItem('root', 'a.service.ts');
    const external = mkItem('startSession', 'x.ts');
    external.uri = {
        path: '/repo/node_modules/mongoose/lib/x.js',
        scheme: 'file',
        toString: () => 'file:///repo/node_modules/mongoose/lib/x.js',
    };
    const graph = toGraph({ item: root, children: [{ item: external, children: [] }] }, root.uri);
    assert.equal(graph.children.length, 0);
});

test('categoriesPresent: dedupes across graphs in palette order', () => {
    const service = mkItem('a', 'a.service.ts');
    const data = mkItem('b', 'b-database.ts');
    const one = toGraph({ item: service, children: [{ item: data, children: [] }] }, service.uri);
    const two = toGraph({ item: service, children: [] }, service.uri);
    assert.deepEqual(categoriesPresent([one, two]), ['service', 'data']);
});
