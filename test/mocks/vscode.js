// Runtime stand-in for the 'vscode' module, just enough for the pure paths
// (graph model, layout, SVG rendering, page shell) to load outside the editor.

const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

module.exports = {
    ColorThemeKind,
    window: {
        activeColorTheme: { kind: ColorThemeKind.Dark },
        createOutputChannel: () => ({ appendLine: () => {} }),
    },
    workspace: {
        getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue }),
        getWorkspaceFolder: () => undefined,
    },
    commands: { executeCommand: async () => undefined },
};
