import type { ITheme } from "@xterm/xterm";

// Single source of truth for the app's 5 themes: which xterm ANSI palette
// (and preview swatch colors) each one maps to. The CSS custom properties
// that theme the app chrome itself live in style.css as static
// `:root[data-theme="..."]` blocks — see the "Theme palettes" section there.
// Keep the two in sync when adding/editing a theme.

export type ThemeName = "midnight" | "nord" | "solarized-dark" | "gruvbox" | "solarized-light";

export interface ThemeDef {
  label: string;
  /** Swatch preview colors for the switcher — mirror --bg/--accent from style.css. */
  previewBg: string;
  previewAccent: string;
  xterm: ITheme;
}

export const STORAGE_KEY = "cc-deck-theme";
export const DEFAULT_THEME: ThemeName = "midnight";
export const THEME_ORDER: ThemeName[] = ["midnight", "nord", "solarized-dark", "gruvbox", "solarized-light"];

export const THEMES: Record<ThemeName, ThemeDef> = {
  midnight: {
    label: "Midnight",
    previewBg: "#0e0e10",
    previewAccent: "#3b82f6",
    xterm: {
      background: "#0e0e10",
      foreground: "#e4e4e7",
      cursor: "#a1a1aa",
      cursorAccent: "#0e0e10",
      selectionBackground: "#3f3f46",
      black: "#27272a",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#f59e0b",
      blue: "#3b82f6",
      magenta: "#a855f7",
      cyan: "#06b6d4",
      white: "#d4d4d8",
      brightBlack: "#52525b",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#fbbf24",
      brightBlue: "#60a5fa",
      brightMagenta: "#c084fc",
      brightCyan: "#22d3ee",
      brightWhite: "#fafafa",
    },
  },
  nord: {
    label: "Nord",
    previewBg: "#2e3440",
    previewAccent: "#88c0d0",
    xterm: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  "solarized-dark": {
    label: "Solarized Dark",
    previewBg: "#002b36",
    previewAccent: "#2aa198",
    xterm: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  gruvbox: {
    label: "Gruvbox",
    previewBg: "#282828",
    previewAccent: "#8ec07c",
    xterm: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  "solarized-light": {
    label: "Solarized Light",
    previewBg: "#fdf6e3",
    previewAccent: "#2aa198",
    xterm: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
};
