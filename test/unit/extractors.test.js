require('../helpers/hook');
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkDocument, mkRangeItem } = require('../helpers/fixtures');
const {
    countParams,
    extractGuards,
    extractMutations,
    extractReturns,
    extractSignature,
} = require('../../out/details/extractors.js');

test('signature: collapses a multi-line declaration up to the body brace', () => {
    const lines = ['public async markAsDefault(', '    id: string,', '    facility: string', '): Promise<User> {', '}'];
    const document = mkDocument(lines);
    assert.equal(
        extractSignature(document, mkRangeItem(lines)),
        'public async markAsDefault( id: string, facility: string ): Promise<User>'
    );
});

test('signature: a destructured parameter brace is not mistaken for the body', () => {
    const lines = ['async foo({ id }: Props) {', '}'];
    assert.equal(extractSignature(mkDocument(lines), mkRangeItem(lines)), 'async foo({ id }: Props)');
});

test('countParams: empty, generic, and function-typed parameters', () => {
    assert.equal(countParams('foo()'), 0);
    assert.equal(countParams('foo(a: string)'), 1);
    assert.equal(countParams('foo(a: Map<string, number>, b: number)'), 2);
    assert.equal(countParams('foo(cb: (x, y) => void, b)'), 2);
    assert.equal(countParams('no parens here'), undefined);
});

test('guards: single-line and split forms, with exit lines reported', () => {
    const lines = [
        'function f() {',
        '    if (!note) throw new NotFoundError()',
        '    if (isDone) {',
        '        return null',
        '    }',
        '    return note',
        '}',
    ];
    const { guards, exitLines } = extractGuards(mkDocument(lines), mkRangeItem(lines));
    assert.equal(guards.length, 2);
    assert.match(guards[0], /if \(!note\) → throw/);
    assert.match(guards[1], /if \(isDone\) → return null/);
    assert.ok(exitLines.has(1));
    assert.ok(exitLines.has(3));
});

test('returns: guard exits are skipped, duplicates collapse, bare return reads as void', () => {
    const lines = ['function f() {', '    if (x) {', '        return early', '    }', '    return', '    return', '}'];
    const { exitLines } = extractGuards(mkDocument(lines), mkRangeItem(lines));
    const returns = extractReturns(mkDocument(lines), mkRangeItem(lines), exitLines);
    assert.deepEqual(returns, ['(void)']);
});

test('mutations: assignments only — comparisons and arrows do not count', () => {
    const lines = [
        'function f() {',
        '    this.sortField = column',
        '    if (this.page === 1) {',
        '    }',
        '    this.handler => noop',
        '    this.page = 2',
        '}',
    ];
    assert.deepEqual(extractMutations(mkDocument(lines), mkRangeItem(lines)), ['sortField', 'page']);
});
