/**
 * Mutation testing with StrykerJS (`{ type: 'mutate' }`, README "Mutation
 * testing"): what `npx stryker run` does for a project tested with
 * `node --test`, with the parts of Stryker that are libraries and a Web
 * Worker where Stryker starts a process.
 *
 * Stryker's own pieces do the work that defines the result: its instrumenter
 * (`@stryker-mutator/instrumenter`) finds the mutants and compiles every one
 * of them into the code behind a switch, `__stryker__.activeMutant`
 * ("mutant switching"); its clear-text reporter prints the report and the
 * score table from the metrics `mutation-testing-metrics` computes. They are
 * in `stryker-<version>.js`, loaded only here (src/stryker/index.ts).
 *
 * What is written here is the loop Stryker's core and its test runner run
 * around them, following `@stryker-mutator/tap-runner`, the runner Stryker
 * has for `node --test`, which runs every test file as a `node` process of
 * its own and treats the file as one test:
 *
 * 1. **Dry run.** Each test file runs once, in a fresh worker (this runner,
 *    as for Test, limited to that file), over the instrumented project with
 *    no mutant active. The instrumented code counts which mutants it
 *    reaches (`__stryker__.mutantCoverage`); that is the file's coverage.
 *    A failing test file stops everything, as in Stryker ("There were
 *    failed tests in the initial test run").
 * 2. **Plan** (core's MutantTestPlanner). A mutant no test file reached is
 *    "NoCoverage" and is not run. Any other runs only the test files that
 *    reached it, with a timeout of `timeoutFactor × net time of those files
 *    + timeoutMS + overhead` (1.5, 5000 ms, and the dry run's time outside
 *    the tests themselves) and a hit limit of 100 times the number of times
 *    the dry run reached it, which ends a mutant that loops without a timer.
 * 3. **Mutant runs.** For each mutant, its test files run one by one, each
 *    in a fresh worker with `__stryker__.activeMutant` set before the
 *    project's modules load, until one fails (bail, Stryker's default):
 *    "Killed" by that file. If none fails it "Survived". Past the timeout
 *    the worker is terminated, as Stryker kills its child process, and the
 *    mutant is a "Timeout"; reaching the hit limit is a Timeout too.
 *    Mutants run in parallel, in as many workers at a time as Stryker would
 *    start processes (`availableParallelism - 1` above 4, else all).
 * 4. **Report**, by Stryker's ClearTextReporter with its default options,
 *    plus the killed and timed-out mutants it prints only at log level
 *    debug. The exit status is 0 once mutation testing has run, whatever
 *    the score (Stryker's default, with no `thresholds.break`).
 *
 * What is mutated: every JavaScript and TypeScript file of the project that
 * `node --test` would not run as a test file (Stryker's default `mutate`
 * looks under `src/` and `lib/`; these projects are flat). A fresh worker
 * per test file and mutant is Stryker's "reload environment" for every
 * mutant, so static mutants (code that runs once, when a module loads)
 * need nothing special.
 */
import type * as Stryker from './stryker/index';

/** The global Stryker's instrumented code reads and writes (`INSTRUMENTER_CONSTANTS.NAMESPACE`). */
export const NAMESPACE = '__stryker__';

/** What a mutant run asks a child worker to do: the Test of one file. */
export interface MutantRun {
	type: 'mutant';
	/** The project with the mutated files instrumented and every file already JavaScript. */
	files: Record<string, string>;
	testFile: string;
	/** The mutant to activate, or null for the dry run. */
	activeMutant: string | null;
	/** Stryker's hit limit for this mutant, or null for none. */
	hitLimit: number | null;
}

/** What the child answers when its test file has run. */
export interface MutantResult {
	type: 'mutant-result';
	/** The Test's exit status: 0 when every test in the file passed. */
	code: number;
	/** The test file's report, as Test prints it, with what the tests printed. */
	report: string;
	/** Milliseconds the file's tests took, outside loading and linking. */
	net: number;
	/** Mutant id to the number of times the file's run reached it. */
	coverage: Record<string, number>;
	/** How often the active mutant was reached, when there was a hit limit. */
	hitCount: number | null;
}

export interface MutateHost {
	files: Record<string, string>;
	/** The project's test files, as Test finds them, in order. */
	testFiles: string[];
	/** A project file as JavaScript (TypeScript stripped as Test strips it); throws with the reason it cannot be. */
	toJavaScript(path: string, source: string): string;
	/** Loads the Stryker bundle (with progress). */
	load(): Promise<typeof Stryker>;
	/** The URL of this runner, which the child workers run. */
	workerUrl: string;
	write(text: string): void;
	phase(text: string): void;
	/** The real setTimeout and clearTimeout. */
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
}

/** Stryker's defaults, from @stryker-mutator/api's option schema. */
const TIMEOUT_MS = 5000;
const TIMEOUT_FACTOR = 1.5;
const HIT_LIMIT_FACTOR = 100;
const DRY_RUN_TIMEOUT_MS = 5 * 60_000;
const OPTIONS = {
	allowConsoleColors: true,
	clearTextReporter: { allowColor: true, allowEmojis: false, logTests: true, maxTestsToLog: 3, reportTests: true, reportMutants: true, reportScoreTable: true, skipFull: false },
	thresholds: { high: 80, low: 60, break: null },
};

/** Files Stryker would mutate here: JavaScript and TypeScript that are not test files or declarations. */
export function filesToMutate(files: Record<string, string>, testFiles: readonly string[]): string[] {
	const tests = new Set(testFiles);
	return Object.keys(files)
		.filter((p) => /\.[mc]?[jt]s$/.test(p) && !/\.d\.[mc]?ts$/.test(p) && !tests.has(p) && !/(^|\/)node_modules\//.test(p))
		.sort();
}

type Status = 'Killed' | 'Survived' | 'NoCoverage' | 'Timeout';

interface Outcome {
	status: Status;
	statusReason?: string;
	killedBy?: string[];
	testsCompleted?: number;
	duration?: number;
}

/** `console`-style `%s`/`%d` formatting, for Stryker's log messages. */
function format(message: string, args: unknown[]): string {
	let i = 0;
	return message.replace(/%[sdj%]/g, (m) => (m === '%%' ? '%' : i < args.length ? String(args[i++]) : m));
}

/**
 * Runs mutation testing over the project and prints Stryker's report;
 * resolves to the exit status.
 */
export async function mutate(host: MutateHost): Promise<number> {
	const { files, testFiles, write } = host;
	const line = (text = '') => write(`${text}\n`);
	const sources = filesToMutate(files, testFiles);
	if (sources.length === 0) {
		line('No files marked to be mutated: Mutate mutates the JavaScript and TypeScript files that are not test files.');
		return 1;
	}

	host.phase('Loading Stryker');
	const stryker = await host.load();
	stryker.chalk.level = 1;
	const quiet = () => {};
	const logger = (debug: boolean) => ({
		debug: debug ? (m: string, ...a: unknown[]) => line(format(m, a)) : quiet,
		info: (m: string, ...a: unknown[]) => line(format(m, a)),
		warn: (m: string, ...a: unknown[]) => line(`${stryker.chalk.yellow('WARN')} ${format(m, a)}`),
		error: (m: string, ...a: unknown[]) => line(`${stryker.chalk.red('ERROR')} ${format(m, a)}`),
		fatal: (m: string, ...a: unknown[]) => line(`${stryker.chalk.red('FATAL')} ${format(m, a)}`),
		trace: quiet,
		isTraceEnabled: () => false,
		isDebugEnabled: () => debug,
		isInfoEnabled: () => true,
		isWarnEnabled: () => true,
		isErrorEnabled: () => true,
		isFatalEnabled: () => true,
	});

	host.phase('Instrumenting');
	const instrumented = await new stryker.Instrumenter(logger(false)).instrument(
		sources.map((name) => ({ name, content: files[name]!, mutate: true })),
		// Stryker's default `mutator` options and no ignorers.
		{ plugins: null, excludedMutations: [], ignorers: [] },
	);
	const project: Record<string, string> = {};
	for (const [path, text] of Object.entries(files)) project[path] = /\.[mc]?[jt]s$/.test(path) ? host.toJavaScript(path, text) : text;
	for (const file of instrumented.files) project[file.name] = host.toJavaScript(file.name, file.content);
	const mutants = instrumented.mutants;
	if (mutants.length === 0) {
		line("It's a mutant-free world, nothing to test.");
		return 0;
	}

	// --- the dry run -----------------------------------------------------------
	host.phase('Initial test run');
	const dryStart = performance.now();
	const dry = new Map<string, MutantResult>();
	for (const testFile of testFiles) {
		const result = await runChild(host, { type: 'mutant', files: project, testFile, activeMutant: null, hitLimit: null }, DRY_RUN_TIMEOUT_MS);
		if (result === 'timeout') {
			line(`${stryker.chalk.red('ERROR')} Initial test run timed out! (${testFile})`);
			return 1;
		}
		dry.set(testFile, result);
		if (result.code !== 0) {
			line(`${stryker.chalk.red('ERROR')} One or more tests failed in the initial test run: ${testFile}`);
			line(result.report.trimEnd());
			line();
			line(`${stryker.chalk.red('ERROR')} There were failed tests in the initial test run.`);
			return 1;
		}
	}
	const gross = performance.now() - dryStart;
	const net = [...dry.values()].reduce((sum, r) => sum + r.net, 0);
	const overhead = Math.max(0, gross - net);
	line(format('Initial test run succeeded. Ran %s tests in %s (net %s ms, overhead %s ms).', [testFiles.length, seconds(gross), Math.round(net), Math.round(overhead)]));

	// --- the plan --------------------------------------------------------------
	const coveredBy = new Map<string, string[]>();
	const hits = new Map<string, number>();
	for (const [testFile, result] of dry) {
		for (const [id, count] of Object.entries(result.coverage)) {
			if (!count) continue;
			(coveredBy.get(id) ?? coveredBy.set(id, []).get(id)!).push(testFile);
			hits.set(id, (hits.get(id) ?? 0) + count);
		}
	}

	// --- the mutant runs -------------------------------------------------------
	const outcomes = new Map<string, Outcome>();
	const toRun = mutants.filter((m) => {
		if (coveredBy.has(m.id)) return true;
		outcomes.set(m.id, { status: 'NoCoverage' });
		return false;
	});
	const total = mutants.length;
	let survived = 0;
	let timedOut = 0;
	const progress = () => host.phase(`Mutation testing ${outcomes.size}/${total} (${survived} survived, ${timedOut} timed out)`);
	progress();
	const runMutant = async (mutant: (typeof mutants)[number]): Promise<Outcome> => {
		const tests = coveredBy.get(mutant.id)!;
		const timeout = TIMEOUT_FACTOR * tests.reduce((sum, t) => sum + dry.get(t)!.net, 0) + TIMEOUT_MS + overhead;
		const hitLimit = HIT_LIMIT_FACTOR * hits.get(mutant.id)!;
		const deadline = performance.now() + timeout;
		const started = performance.now();
		let completed = 0;
		for (const testFile of tests) {
			const result = await runChild(host, { type: 'mutant', files: project, testFile, activeMutant: mutant.id, hitLimit }, Math.max(0, deadline - performance.now()));
			const duration = Math.round(performance.now() - started);
			if (result === 'timeout') return { status: 'Timeout', duration };
			// The instrumented code throws past the hit limit; that is a timeout, as in Stryker.
			if (result.hitCount !== null && result.hitCount > hitLimit) return { status: 'Timeout', statusReason: `Hit limit reached (${result.hitCount}/${hitLimit})`, duration };
			completed++;
			if (result.code !== 0) return { status: 'Killed', killedBy: [testFile], testsCompleted: completed, duration };
		}
		return { status: 'Survived', testsCompleted: completed, duration: Math.round(performance.now() - started) };
	};
	const cores = navigator.hardwareConcurrency || 1;
	const concurrency = Math.min(toRun.length, cores > 4 ? cores - 1 : cores);
	let next = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < toRun.length) {
				const mutant = toRun[next++]!;
				const outcome = await runMutant(mutant);
				outcomes.set(mutant.id, outcome);
				if (outcome.status === 'Survived') survived++;
				if (outcome.status === 'Timeout') timedOut++;
				progress();
			}
		}),
	);

	// --- the report ------------------------------------------------------------
	// As core's MutationTestReportHelper builds it: schema locations are
	// 1-based, test ids are numbered in the order of the tests.
	const testIds = new Map(testFiles.map((t, i) => [t, String(i)]));
	const report = {
		schemaVersion: '1.0',
		thresholds: OPTIONS.thresholds,
		files: Object.fromEntries(
			sources.map((name) => [
				name,
				{
					language: /\.[mc]?ts$/.test(name) ? 'typescript' : 'javascript',
					source: files[name]!,
					mutants: mutants
						.filter((m) => m.fileName === name)
						.map((m) => {
							const { killedBy, ...outcome } = outcomes.get(m.id)!;
							return {
								id: m.id,
								mutatorName: m.mutatorName,
								replacement: m.replacement,
								location: {
									start: { line: m.location.start.line + 1, column: m.location.start.column + 1 },
									end: { line: m.location.end.line + 1, column: m.location.end.column + 1 },
								},
								static: false,
								coveredBy: (coveredBy.get(m.id) ?? []).map((t) => testIds.get(t)!),
								...(killedBy ? { killedBy: killedBy.map((t) => testIds.get(t)!) } : {}),
								...outcome,
							};
						}),
				},
			]),
		),
		testFiles: Object.fromEntries(testFiles.map((t) => [t, { source: files[t]!, tests: [{ id: testIds.get(t)!, name: t }] }])),
	};
	const metrics = stryker.calculateMutationTestMetrics(report as Parameters<typeof stryker.calculateMutationTestMetrics>[0]);
	const reporter = new stryker.ClearTextReporter(logger(true) as never, OPTIONS as never);
	reporter.onMutationTestReportReady(report as never, metrics);
	const score = metrics.systemUnderTestMetrics.metrics.mutationScore;
	line(`Mutation score: ${Number.isNaN(score) ? 'n/a' : `${score.toFixed(2)}%`} (${seconds(performance.now() - dryStart)})`);
	return 0;
}

function seconds(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} seconds`;
}

/**
 * Runs one test file in a fresh worker and resolves to its result, or to
 * 'timeout' after `timeout` ms, when the worker is terminated. A worker that
 * fails to start or throws outside the tests counts as a failed file.
 */
function runChild(host: MutateHost, run: MutantRun, timeout: number): Promise<MutantResult | 'timeout'> {
	return new Promise((resolve) => {
		const worker = new Worker(host.workerUrl, { type: 'module', name: `mutant ${run.activeMutant ?? 'dry run'} ${run.testFile}` });
		const done = (result: MutantResult | 'timeout') => {
			host.clearTimeout(timer);
			worker.terminate();
			resolve(result);
		};
		const timer = host.setTimeout(() => done('timeout'), timeout);
		worker.onmessage = (e: MessageEvent<MutantResult | { type: string }>) => {
			if (e.data.type === 'mutant-result') done(e.data as MutantResult);
		};
		worker.onerror = (e) => {
			e.preventDefault();
			done({ type: 'mutant-result', code: 1, report: `The test worker failed: ${e.message}`, net: 0, coverage: {}, hitCount: null });
		};
		worker.postMessage(run);
	});
}
