/**
 * Monaco languages for the compiler output views (compiler-view.ts): LLVM
 * IR (`llvm-ir`) and the assembly of each target clang prints for
 * (`asm-x86_64` in AT&T or Intel syntax, `asm-aarch64`, `asm-riscv64`,
 * `asm-wasm32`). Monaco has none of them. Each is a Monarch tokenizer and a
 * language configuration (comments, brackets), and nothing else: the views
 * are read only and no server answers for them.
 *
 * The token names are the ones the app's themes colour (theme.svelte.ts,
 * and Monaco's own `vs`/`vs-dark` rules underneath), so both themes work:
 * `keyword` for mnemonics, `variable.predefined` for registers, `type` for
 * labels and types, `metatag` for directives, `annotation` for metadata and
 * attribute groups, and `comment`, `string`, `number`, `identifier`.
 *
 * Loaded by dynamic `import()` with compiler-view.ts, the first time a view
 * opens, so a session without one never downloads them. Monaco itself is
 * passed in (registerOutputLanguages) rather than imported: a lazy chunk
 * that imported the app's Monaco module would make the bundler split that
 * module out of the page's chunk into a shared one, and the app shell
 * would grow by the compression the split loses.
 */
import type { monaco as Monaco } from './monaco';
import type { AsmLanguage } from './cpp-targets';

type MonacoApi = typeof Monaco;
type Rule = Monaco.languages.IMonarchLanguageRule;

/** What tells one target's assembly from another's. */
interface AsmDialect {
	/** Rules for comments, tried first everywhere. */
	comments: Rule[];
	/** Registers, as one regular expression. */
	registers: RegExp;
	/** Immediates and other numbers. */
	numbers: Rule[];
	/** Rules for operands only this dialect has (size keywords, relocation operators). */
	extra?: Rule[];
	/** The language configuration's line comment. */
	lineComment: string;
}

/**
 * A Monarch tokenizer for one target's assembly as clang prints it: a line is
 * a label (anything up to a colon that ends it, demangled names with their
 * spaces and parentheses included), or a mnemonic or directive followed by
 * operands. A line always starts in `root`; the line feed (`includeLF`)
 * ends the operands, so an operand is never taken for a mnemonic.
 */
function asmTokenizer(d: AsmDialect): Monaco.languages.IMonarchLanguage {
	const operand: Rule[] = [
		[d.registers, 'variable.predefined'],
		...(d.extra ?? []),
		[/"(?:[^"\\]|\\.)*"/, 'string'],
		...d.numbers,
		[/[A-Za-z_.$?][\w.$?]*/, 'identifier'],
		[/@[\w]+/, 'predefined'],
		[/[()[\]{}<>]/, '@brackets'],
		[/[,:+\-*!&=|^~]/, 'delimiter'],
		[/[ \t]+/, 'white'],
	];
	return {
		defaultToken: '',
		includeLF: true,
		tokenizer: {
			root: [
				...d.comments,
				[/^[^\s#;/][^\n]*?:(?=[ \t]*(?:#|;|\/\/|\n|$))/, 'type'],
				[/[ \t]+/, 'white'],
				[/\.[\w.]+/, { token: 'metatag', next: '@operands' }],
				[/[A-Za-z_][\w.]*/, { token: 'keyword', next: '@operands' }],
				[/\n/, ''],
			],
			operands: [...d.comments, [/\n/, '', '@pop'], ...operand],
		},
	};
}

const HEX_OR_DEC = /-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/;

const DIALECTS: Record<AsmLanguage, AsmDialect> = {
	// AT&T (`%rax`, `$1`) and Intel (`rax`, `qword ptr [rsp + 8]`), whichever the toggle asked for.
	'asm-x86_64': {
		comments: [[/#.*/, 'comment']],
		registers: /%[a-z][a-z0-9]*|\b(?:[re]?(?:ax|bx|cx|dx|si|di|sp|bp|ip)|[abcd][lh]|(?:si|di|sp|bp)l|r(?:[89]|1[0-5])[dwb]?|[xyz]mm(?:[12]?\d|3[01])|[c-gs]s|k[0-7])\b/,
		numbers: [[/\$?-?(?:0x[0-9a-fA-F]+|\d+)\b/, 'number']],
		extra: [[/\b(?:byte|word|dword|qword|xmmword|ymmword|zmmword|tbyte|ptr|offset)\b/, 'type']],
		lineComment: '#',
	},
	'asm-aarch64': {
		// `#` is an immediate here (`#16`), not a comment.
		comments: [[/\/\/.*/, 'comment']],
		registers: /\b(?:[xw](?:[12]?\d|30)|[xw]zr|w?sp|lr|fp|pc|nzcv|[bhsdqv](?:[12]?\d|3[01])(?:\.\d*[bhsdq])?)\b/,
		numbers: [[/#?-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/, 'number']],
		extra: [
			[/:(?:lo12|got|got_lo12|tprel_lo12_nc|tprel_hi12|pg_hi21):/, 'predefined'],
			[/\b(?:lsl|lsr|asr|ror|uxt[bhwx]|sxt[bhwx]|eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)\b/, 'type'],
		],
		lineComment: '//',
	},
	'asm-riscv64': {
		comments: [[/#.*/, 'comment']],
		registers: /\b(?:zero|ra|sp|gp|tp|fp|t[0-6]|s(?:1[01]|\d)|a[0-7]|f[tsa]\d{1,2}|x(?:[12]?\d|3[01])|f(?:[12]?\d|3[01]))\b/,
		numbers: [[HEX_OR_DEC, 'number']],
		extra: [[/%(?:hi|lo|pcrel_hi|pcrel_lo|tprel_hi|tprel_lo|tprel_add|got_pcrel_hi)\b/, 'predefined']],
		lineComment: '#',
	},
	// Locals and globals are WebAssembly's registers: `local.get 0`.
	'asm-wasm32': {
		comments: [
			[/#.*/, 'comment'],
			[/;;.*/, 'comment'],
		],
		registers: /\b(?:local|global)\.(?:get|set|tee)\b/,
		numbers: [[HEX_OR_DEC, 'number']],
		extra: [[/\b(?:i32|i64|f32|f64|v128|funcref|externref|exnref)\b/, 'type']],
		lineComment: '#',
	},
};

/** WebAssembly's `local.get` and `global.set` start a line as an instruction too: coloured as registers there. */
function wasmTokenizer(): Monaco.languages.IMonarchLanguage {
	const base = asmTokenizer(DIALECTS['asm-wasm32']);
	const root = base.tokenizer['root'] ?? [];
	return { ...base, tokenizer: { ...base.tokenizer, root: [[/\b(?:local|global)\.(?:get|set|tee)\b/, { token: 'variable.predefined', next: '@operands' }], ...root] } };
}

/** LLVM IR's instructions, linkage and other words that are not types or attributes. */
const IR_KEYWORDS = [
	'define', 'declare', 'global', 'constant', 'private', 'internal', 'external', 'linkonce', 'linkonce_odr', 'weak', 'weak_odr', 'common', 'appending', 'extern_weak', 'available_externally',
	'dso_local', 'dso_preemptable', 'unnamed_addr', 'local_unnamed_addr', 'thread_local', 'hidden', 'protected', 'default', 'dllimport', 'dllexport', 'section', 'comdat', 'any', 'align', 'alignstack',
	'target', 'datalayout', 'triple', 'source_filename', 'attributes', 'personality', 'type', 'to', 'x', 'unwind', 'cleanup', 'catch', 'filter', 'within', 'from', 'caller',
	'ret', 'br', 'switch', 'indirectbr', 'invoke', 'resume', 'unreachable', 'callbr', 'landingpad', 'catchswitch', 'catchret', 'cleanupret', 'catchpad', 'cleanuppad',
	'fneg', 'add', 'fadd', 'sub', 'fsub', 'mul', 'fmul', 'udiv', 'sdiv', 'fdiv', 'urem', 'srem', 'frem', 'shl', 'lshr', 'ashr', 'and', 'or', 'xor',
	'extractelement', 'insertelement', 'shufflevector', 'extractvalue', 'insertvalue', 'alloca', 'load', 'store', 'fence', 'cmpxchg', 'atomicrmw', 'getelementptr',
	'trunc', 'zext', 'sext', 'fptrunc', 'fpext', 'fptoui', 'fptosi', 'uitofp', 'sitofp', 'ptrtoint', 'inttoptr', 'bitcast', 'addrspacecast',
	'icmp', 'fcmp', 'phi', 'select', 'freeze', 'call', 'tail', 'musttail', 'notail', 'va_arg',
	'eq', 'ne', 'ugt', 'uge', 'ult', 'ule', 'sgt', 'sge', 'slt', 'sle', 'oeq', 'ogt', 'oge', 'olt', 'ole', 'one', 'ord', 'ueq', 'une', 'uno',
	'nuw', 'nsw', 'exact', 'disjoint', 'nneg', 'inbounds', 'nusw', 'volatile', 'atomic', 'unordered', 'monotonic', 'acquire', 'release', 'acq_rel', 'seq_cst', 'syncscope',
	'fast', 'nnan', 'ninf', 'nsz', 'arcp', 'contract', 'afn', 'reassoc', 'true', 'false', 'null', 'undef', 'poison', 'zeroinitializer', 'none', 'blockaddress', 'dso_local_equivalent', 'no_cfi',
	'ccc', 'fastcc', 'coldcc', 'tailcc', 'swiftcc', 'cc', 'addrspace', 'vscale', 'asm', 'sideeffect', 'inteldialect',
];

/** Parameter, return and function attributes, as clang writes them. */
const IR_ATTRIBUTES = [
	'noundef', 'nonnull', 'nocapture', 'captures', 'readonly', 'readnone', 'writeonly', 'returned', 'signext', 'zeroext', 'inreg', 'byval', 'byref', 'sret', 'noalias', 'nofree', 'nest', 'swiftself', 'swifterror', 'immarg', 'noext',
	'dereferenceable', 'dereferenceable_or_null', 'allocalign', 'allocptr', 'initializes', 'range', 'nofpclass', 'writable', 'dead_on_unwind', 'inalloca', 'preallocated', 'elementtype', 'memory', 'argmem', 'inaccessiblemem', 'read', 'write', 'readwrite',
	'nounwind', 'mustprogress', 'noinline', 'alwaysinline', 'inlinehint', 'optnone', 'optsize', 'minsize', 'uwtable', 'norecurse', 'willreturn', 'nosync', 'noreturn', 'cold', 'hot', 'convergent', 'speculatable', 'nobuiltin', 'builtin',
	'ssp', 'sspstrong', 'sspreq', 'safestack', 'sanitize_address', 'sanitize_memory', 'sanitize_thread', 'nocallback', 'nomerge', 'noduplicate', 'returns_twice', 'strictfp', 'null_pointer_is_valid', 'noimplicitfloat', 'naked',
	'allockind', 'allocsize', 'local_unnamed_addr', 'nocf_check', 'shadowcallstack', 'mustprogress', 'noprofile', 'skipprofile', 'presplitcoroutine', 'fn_ret_thunk_extern', 'nonlazybind', 'jumptable', 'disable_sanitizer_instrumentation',
];

/** LLVM IR as clang prints it with `-S -emit-llvm`. */
function irTokenizer(): Monaco.languages.IMonarchLanguage {
	return {
		defaultToken: '',
		keywords: IR_KEYWORDS,
		attributes: IR_ATTRIBUTES,
		tokenizer: {
			root: [
				[/;.*$/, 'comment'],
				[/^[\w.$-]+:/, 'type'],
				[/c?"(?:[^"\\]|\\.)*"/, 'string'],
				[/@(?:"(?:[^"\\]|\\.)*"|[\w.$-]+)/, 'variable.predefined'],
				[/%(?:"(?:[^"\\]|\\.)*"|[\w.$-]+)/, 'variable'],
				[/!(?:[A-Za-z_.][\w.$-]*|\d+)?/, 'annotation'],
				[/#\d+/, 'annotation'],
				[/\b(?:i\d+|void|half|bfloat|float|double|fp128|x86_fp80|ppc_fp128|ptr|label|metadata|token|opaque|x86_amx)\b/, 'type'],
				[/-?0x[KLMHR]?[0-9A-Fa-f]+\b/, 'number'],
				[/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'number'],
				[/[A-Za-z_][\w.$-]*/, { cases: { '@keywords': 'keyword', '@attributes': 'attribute.name', '@default': 'identifier' } }],
				[/[()[\]{}<>]/, '@brackets'],
				[/[,=*:]/, 'delimiter'],
				[/[ \t]+/, 'white'],
			],
		},
	};
}

const BRACKETS: Monaco.languages.CharacterPair[] = [
	['(', ')'],
	['[', ']'],
	['{', '}'],
	['<', '>'],
];

/** Every language registered here, with what it is called. */
export const OUTPUT_LANGUAGES = ['llvm-ir', 'asm-x86_64', 'asm-aarch64', 'asm-riscv64', 'asm-wasm32'] as const;

/**
 * Registers every language of OUTPUT_LANGUAGES with `monaco`: its id, its
 * tokenizer and its configuration. Calling it again does nothing.
 */
export function registerOutputLanguages(monaco: MonacoApi): void {
	const register = (id: string, alias: string, tokenizer: Monaco.languages.IMonarchLanguage, lineComment: string) => {
		if (monaco.languages.getLanguages().some((l) => l.id === id)) return;
		monaco.languages.register({ id, aliases: [alias] });
		monaco.languages.setMonarchTokensProvider(id, tokenizer);
		monaco.languages.setLanguageConfiguration(id, { comments: { lineComment }, brackets: BRACKETS });
	};
	register('llvm-ir', 'LLVM IR', irTokenizer(), ';');
	register('asm-x86_64', 'x86-64 assembly', asmTokenizer(DIALECTS['asm-x86_64']), DIALECTS['asm-x86_64'].lineComment);
	register('asm-aarch64', 'AArch64 assembly', asmTokenizer(DIALECTS['asm-aarch64']), DIALECTS['asm-aarch64'].lineComment);
	register('asm-riscv64', 'RISC-V assembly', asmTokenizer(DIALECTS['asm-riscv64']), DIALECTS['asm-riscv64'].lineComment);
	register('asm-wasm32', 'WebAssembly assembly', wasmTokenizer(), DIALECTS['asm-wasm32'].lineComment);
}
