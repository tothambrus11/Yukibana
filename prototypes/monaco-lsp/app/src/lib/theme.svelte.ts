/**
 * Light and dark themes. The page's colours are CSS variables keyed on
 * `<html data-theme>`; Monaco needs its own theme objects, defined here with
 * the same palette. The choice follows the system until the user toggles it.
 */
import { monaco } from './monaco';

export type Theme = 'light' | 'dark';

const KEY = 'yukibana.code.theme';

monaco.editor.defineTheme('yukibana-dark', {
	base: 'vs-dark',
	inherit: true,
	rules: [
		{ token: 'comment', foreground: '7f7676', fontStyle: 'italic' },
		{ token: 'keyword', foreground: 'e0788f' },
		{ token: 'string', foreground: '9ccf8a' },
		{ token: 'number', foreground: '6fc2c6' },
		{ token: 'type', foreground: '72c2a0' },
	],
	colors: {
		'editor.background': '#121111',
		'editor.lineHighlightBackground': '#1f1c1c',
		'editorLineNumber.foreground': '#635c5c',
		'editorLineNumber.activeForeground': '#e3dcdc',
		'editorGutter.background': '#121111',
		'editorWidget.background': '#1f1c1c',
		'editorWidget.border': '#2e2a2a',
		'editorHoverWidget.background': '#1f1c1c',
		'editorHoverWidget.border': '#2e2a2a',
		'editorSuggestWidget.background': '#1f1c1c',
		'editorSuggestWidget.border': '#2e2a2a',
		'editorSuggestWidget.selectedBackground': '#2b7256aa',
		'list.hoverBackground': '#2e2a2a',
		focusBorder: '#2b7256',
		'editorCursor.foreground': '#4e9375',
		'editor.selectionBackground': '#2b725666',
	},
});

monaco.editor.defineTheme('yukibana-light', {
	base: 'vs',
	inherit: true,
	rules: [
		{ token: 'comment', foreground: '8a8080', fontStyle: 'italic' },
		{ token: 'keyword', foreground: 'b3264f' },
		{ token: 'string', foreground: '3c7a28' },
		{ token: 'number', foreground: '0d7b80' },
		{ token: 'type', foreground: '018053' },
	],
	colors: {
		'editor.background': '#ffffff',
		'editor.lineHighlightBackground': '#f4f1f1',
		'editorLineNumber.foreground': '#a59c9c',
		'editorLineNumber.activeForeground': '#352b2b',
		'editorWidget.background': '#faf8f8',
		'editorWidget.border': '#ddd5d5',
		'editorHoverWidget.background': '#faf8f8',
		'editorHoverWidget.border': '#ddd5d5',
		'editorSuggestWidget.background': '#faf8f8',
		'editorSuggestWidget.border': '#ddd5d5',
		focusBorder: '#018053',
		'editorCursor.foreground': '#018053',
		'editor.selectionBackground': '#01805333',
	},
});

function initial(): Theme {
	try {
		const saved = localStorage.getItem(KEY);
		if (saved === 'light' || saved === 'dark') return saved;
	} catch {
		// Storage disabled: follow the system.
	}
	return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The current theme; set `current` to change it everywhere. */
class ThemeState {
	#current = $state<Theme>(initial());

	constructor() {
		this.apply();
	}

	get current(): Theme {
		return this.#current;
	}

	set current(theme: Theme) {
		this.#current = theme;
		try {
			localStorage.setItem(KEY, theme);
		} catch {
			// Not remembered; still applied.
		}
		this.apply();
	}

	toggle(): void {
		this.current = this.#current === 'dark' ? 'light' : 'dark';
	}

	private apply(): void {
		document.documentElement.dataset['theme'] = this.#current;
		monaco.editor.setTheme(`yukibana-${this.#current}`);
	}
}

export const theme = new ThemeState();
