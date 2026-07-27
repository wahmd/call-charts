# Hover Call Graph

Hover over a function/method name and the tooltip shows the tree of functions it calls (nested up to 3 levels). Workspace functions are clickable; external library calls are labeled with their package name.

Built on VS Code's call-hierarchy API (`vscode.provideOutgoingCalls`), so resolution is done by the TypeScript language server.
