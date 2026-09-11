import type { ITheme } from '@xterm/xterm';

export interface ThemeDefinition {
  /** 主题名（存储用） */
  name: string;
  /** 界面显示名 */
  label: string;
  /** 界面主题：dark / light，与 CSS 变量联动 */
  ui: 'dark' | 'light';
  /** xterm 终端配色 */
  terminal: ITheme;
}

/**
 * 终端主题表。
 * 颜色均经过挑选，保证最低对比度可读性；深色主题为默认值。
 */
export const THEMES: Record<string, ThemeDefinition> = {
  dark: {
    name: 'dark',
    label: '深色（默认）',
    ui: 'dark',
    terminal: {
      background: '#101317',
      foreground: '#d8dee9',
      cursor: '#7cb7ff',
      cursorAccent: '#101317',
      selectionBackground: '#2b4a75',
      selectionForeground: '#ffffff',
      selectionInactiveBackground: '#26364d',
      black: '#1b1f27',
      red: '#f2777a',
      green: '#99cc99',
      yellow: '#ffcc66',
      blue: '#6699cc',
      magenta: '#c594c5',
      cyan: '#66cccc',
      white: '#d8dee9',
      brightBlack: '#5c6370',
      brightRed: '#ff8b8b',
      brightGreen: '#b3e6b3',
      brightYellow: '#ffe08a',
      brightBlue: '#8ab4f8',
      brightMagenta: '#d9a9d9',
      brightCyan: '#8ee6e6',
      brightWhite: '#ffffff',
    },
  },
  'dark-contrast': {
    name: 'dark-contrast',
    label: '深色 · 高对比',
    ui: 'dark',
    terminal: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#00ff9c',
      cursorAccent: '#000000',
      selectionBackground: '#3a5f8f',
      selectionForeground: '#ffffff',
      black: '#000000',
      red: '#ff5555',
      green: '#55ff55',
      yellow: '#ffff55',
      blue: '#5599ff',
      magenta: '#ff55ff',
      cyan: '#55ffff',
      white: '#ffffff',
      brightBlack: '#808080',
      brightRed: '#ff8080',
      brightGreen: '#80ff80',
      brightYellow: '#ffff80',
      brightBlue: '#80b3ff',
      brightMagenta: '#ff80ff',
      brightCyan: '#80ffff',
      brightWhite: '#ffffff',
    },
  },
  'solarized-dark': {
    name: 'solarized-dark',
    label: 'Solarized 深色',
    ui: 'dark',
    terminal: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#0f4b57',
      selectionForeground: '#fdf6e3',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
  light: {
    name: 'light',
    label: '浅色',
    ui: 'light',
    terminal: {
      background: '#fbfcfe',
      foreground: '#20242c',
      cursor: '#2f6fe4',
      cursorAccent: '#ffffff',
      selectionBackground: '#b9d3ff',
      selectionForeground: '#10131a',
      black: '#20242c',
      red: '#c3384a',
      green: '#1a7f4b',
      yellow: '#8a6100',
      blue: '#2f6fe4',
      magenta: '#8e44ad',
      cyan: '#0f7b8a',
      white: '#e6e9ef',
      brightBlack: '#5b6675',
      brightRed: '#e05561',
      brightGreen: '#2aa06a',
      brightYellow: '#b38000',
      brightBlue: '#4c8dff',
      brightMagenta: '#a86cc4',
      brightCyan: '#2aa3b5',
      brightWhite: '#ffffff',
    },
  },
};

export const THEME_ORDER = ['dark', 'dark-contrast', 'solarized-dark', 'light'];

export function getTheme(name: string | undefined): ThemeDefinition {
  return (name && THEMES[name]) || THEMES.dark;
}

/** 把主题应用到 body（驱动 CSS 变量） */
export function applyUiTheme(name: string): void {
  const theme = getTheme(name);
  document.body.dataset.theme = theme.ui;
}

/** 在深色 / 浅色之间切换，返回新的主题名 */
export function nextTheme(current: string): string {
  return getTheme(current).ui === 'dark' ? 'light' : 'dark';
}
