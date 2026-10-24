/**
 * Haskell for Monaco, which has no grammar of its own for it: the language
 * id `haskell` for `.hs` files, a Monarch tokenizer and the bracket, comment
 * and indentation rules. Imported for its effect by `monaco.ts`. Everything
 * that needs the type checker (errors, hover, completion) comes from the
 * Haskell pack's server; this is only what colours text and what Enter and
 * the comment commands do.
 */
import * as monaco from 'monaco-editor/editor/editor.api';

monaco.languages.register({ id: 'haskell', extensions: ['.hs'], aliases: ['Haskell', 'haskell'] });

// The rules are set when the first Haskell model appears, as Monaco's own
// language registrations do: setting them now would start Monaco's services
// while this module is imported, before monaco.ts gives them its overrides
// (the label service that names files by project path), which then never apply.
monaco.languages.onLanguage('haskell', () => {
	monaco.languages.setLanguageConfiguration('haskell', {
		comments: { lineComment: '--', blockComment: ['{-', '-}'] },
		brackets: [
			['(', ')'],
			['[', ']'],
			['{', '}'],
		],
		// No auto-closing quote after a letter: `x'` and `f''` are names.
		autoClosingPairs: [
			{ open: '(', close: ')' },
			{ open: '[', close: ']' },
			{ open: '{', close: '}' },
			{ open: '"', close: '"', notIn: ['string', 'comment'] },
		],
		surroundingPairs: [
			{ open: '(', close: ')' },
			{ open: '[', close: ']' },
			{ open: '{', close: '}' },
			{ open: '"', close: '"' },
		],
		// Names may hold primes, which the default word pattern splits on: the
		// word under the cursor is what hover and rename are asked about.
		wordPattern: /[A-Za-z_][\w']*|[-!#$%&*+./<=>?@\\^|~:]+/,
		// Layout: after a line ending in a block keyword or `=` the next line
		// is indented, as every Haskell editor does.
		onEnterRules: [
			{
				beforeText: /(\b(where|do|of|let|in|then|else|mdo|rec|\\case)|=|->|::)\s*(--.*)?$/,
				action: { indentAction: monaco.languages.IndentAction.Indent },
			},
		],
		indentationRules: {
			increaseIndentPattern: /(\b(where|do|of|let|mdo)|=)\s*$/,
			decreaseIndentPattern: /^\s*$/,
		},
	});

	monaco.languages.setMonarchTokensProvider('haskell', {
		defaultToken: '',
		tokenPostfix: '.hs',
		keywords: [
			'case', 'class', 'data', 'default', 'deriving', 'do', 'else', 'forall', 'foreign', 'if', 'import', 'in',
			'infix', 'infixl', 'infixr', 'instance', 'let', 'mdo', 'module', 'newtype', 'of', 'pattern', 'proc',
			'qualified', 'rec', 'then', 'type', 'where', 'family', 'stock', 'anyclass', 'via',
		],
		// Reserved operators: punctuation of the language, not functions.
		reservedOps: ['..', ':', '::', '=', '\\', '|', '<-', '->', '@', '~', '=>'],
		symbols: /[-!#$%&*+./<=>?@\\^|~:]+/,
		escapes: /\\(?:[abfnrtv\\"'&]|\^[A-Z@[\\\]^_]|NUL|SOH|STX|ETX|EOT|ENQ|ACK|BEL|BS|HT|LF|VT|FF|CR|SO|SI|DLE|DC[1-4]|NAK|SYN|ETB|CAN|EM|SUB|ESC|FS|GS|RS|US|SP|DEL|\d+|o[0-7]+|x[0-9A-Fa-f]+)/,
		tokenizer: {
			root: [
				[/\{-#/, 'annotation', '@pragma'],
				[/\{-/, 'comment', '@comment'],
				// `--` starts a comment only when the dashes are not part of a longer
				// operator: `-->` is an operator, `---` a comment.
				[/--+(?![!#$%&*+./<=>?@\\^|~:]).*$/, 'comment'],
				// Qualified names: the module part is a namespace, then a name, a
				// constructor or an operator.
				[/(?:[A-Z][\w']*\.)+[a-z_][\w']*/, 'identifier'],
				[/(?:[A-Z][\w']*\.)*[A-Z][\w']*/, 'type.identifier'],
				[/[a-z_][\w']*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
				[/0[xX][0-9a-fA-F_]+/, 'number.hex'],
				[/0[oO][0-7_]+/, 'number.octal'],
				[/0[bB][01_]+/, 'number.binary'],
				[/\d[\d_]*(\.\d[\d_]*)?([eE][-+]?\d+)?/, 'number'],
				[/"/, 'string', '@string'],
				// A character literal, not a prime: the quote follows no name here,
				// since the name rules above take their primes with them.
				[/'(?:[^\\']|@escapes)'/, 'string'],
				[/`[A-Za-z_][\w'.]*`/, 'operator'],
				// Only brackets may be @brackets: Monarch gives up on the rest of the
				// line at a comma that is.
				[/[()[\]{}]/, '@brackets'],
				[/[,;]/, 'delimiter'],
				[/@symbols/, { cases: { '@reservedOps': 'keyword.operator', '@default': 'operator' } }],
				[/\s+/, 'white'],
			],
			// Block comments nest in Haskell.
			comment: [
				[/[^{-]+/, 'comment'],
				[/\{-/, 'comment', '@push'],
				[/-\}/, 'comment', '@pop'],
				[/[{-]/, 'comment'],
			],
			pragma: [
				[/[^#]+/, 'annotation'],
				[/#-\}/, 'annotation', '@pop'],
				[/#/, 'annotation'],
			],
			string: [
				[/[^\\"]+/, 'string'],
				[/@escapes/, 'string.escape'],
				// A gap: a backslash, white space (newlines included), a backslash.
				[/\\\s*$/, 'string.escape', '@gap'],
				[/\\./, 'string.escape.invalid'],
				[/"/, 'string', '@pop'],
			],
			gap: [
				[/\s*\\/, 'string.escape', '@pop'],
				[/\s+$/, 'string.escape'],
				[/.*/, 'string.escape.invalid', '@pop'],
			],
		},
	});
});
