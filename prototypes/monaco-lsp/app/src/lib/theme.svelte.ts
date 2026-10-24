/**
 * Light and dark themes. The page's colours are CSS variables keyed on
 * `<html data-theme>`; Monaco needs its own theme objects, defined here with
 * the same palette, every text colour at least 7:1 against the editor
 * (palette.ts). The choice follows the system until the user toggles it.
 */
import { vs, vs_dark } from 'monaco-editor/editor/standalone/common/themes';
import { monaco } from './monaco';
import { EDITOR, LINE_NUMBERS, OWN_RULES, raise, raisedRules, TEXT_CONTRAST, viewText, type Hex, type Theme } from './palette';

export type { Theme };

const KEY = 'yukibana.code.theme';

/**
 * Every token rule of a theme, Monaco's underneath the theme's own, with
 * each colour raised to TEXT_CONTRAST (palette.ts says why). Monaco's rules
 * are repeated rather than inherited so that the ones below the contrast
 * (vs-dark's registers, `variable.predefined`, at 3.3:1) are raised too.
 */
export const THEME_RULES: Record<Theme, monaco.editor.ITokenThemeRule[]> = {
	dark: raisedRules(vs_dark.rules, OWN_RULES.dark, EDITOR.dark.background),
	light: raisedRules(vs.rules, OWN_RULES.light, EDITOR.light.background),
};

/** The line numbers, raised like the tokens. */
const lineNumbers = (theme: Theme) => ({
	'editorLineNumber.foreground': raise(LINE_NUMBERS[theme].normal, EDITOR[theme].background, TEXT_CONTRAST),
	'editorLineNumber.activeForeground': raise(LINE_NUMBERS[theme].active, EDITOR[theme].caretLine, TEXT_CONTRAST),
});

/** Every text colour the linked views can draw on a tinted row, per theme (link-colours.ts checks the tints against them). */
export const VIEW_TEXT: Record<Theme, Hex[]> = {
	dark: viewText(THEME_RULES.dark, lineNumbers('dark')),
	light: viewText(THEME_RULES.light, lineNumbers('light')),
};

monaco.editor.defineTheme('yukibana-dark', {
	base: 'vs-dark',
	inherit: true,
	rules: THEME_RULES.dark,
	colors: {
		'editor.background': EDITOR.dark.background,
		'editor.lineHighlightBackground': EDITOR.dark.caretLine,
		...lineNumbers('dark'),
		'editorGutter.background': EDITOR.dark.background,
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
	rules: THEME_RULES.light,
	colors: {
		'editor.background': EDITOR.light.background,
		'editor.lineHighlightBackground': EDITOR.light.caretLine,
		...lineNumbers('light'),
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
		// The installed app's title bar: app.html picks by system theme; a toggle overrides both.
		for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = this.#current === 'dark' ? '#121111' : '#fbfafa';
	}
}

export const theme = new ThemeState();
