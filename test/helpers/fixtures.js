// Shared builders for fake call-hierarchy data.

function mkItem(name, file, line = 10) {
    return {
        name,
        uri: { path: '/repo/src/' + file, scheme: 'file', toString: () => 'file:///repo/src/' + file },
        selectionRange: { start: { line, character: 4 } },
        range: { start: { line, character: 0 }, end: { line: line + 10, character: 1 } },
        kind: 5,
    };
}

// a TextDocument stand-in over an array of source lines
function mkDocument(lines) {
    return { lineAt: (lineNo) => ({ text: lines[lineNo] ?? '' }) };
}

// a CallHierarchyItem whose range covers the given lines
function mkRangeItem(lines) {
    return {
        name: 'subject',
        uri: { path: '/repo/src/subject.ts', scheme: 'file', toString: () => 'file:///repo/src/subject.ts' },
        selectionRange: { start: { line: 0, character: 0 } },
        range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: 0 } },
    };
}

module.exports = { mkItem, mkDocument, mkRangeItem };
