// Routes require('vscode') to the runtime mock so the compiled extension
// modules load as-is under plain Node. Require this before any out/ module.

const Module = require('module');
const path = require('path');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') {
        return path.join(__dirname, '..', 'mocks', 'vscode.js');
    }
    return originalResolve.call(this, request, ...rest);
};
