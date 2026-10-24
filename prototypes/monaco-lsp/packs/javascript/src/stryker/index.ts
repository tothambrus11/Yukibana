/**
 * The parts of StrykerJS 10.1.1 that Mutate uses, bundled into one ES module
 * (`stryker-<version>.js`, tools/stryker.mjs) that the runner loads only
 * when the user asks for mutation testing (src/mutate.ts):
 *
 * * `Instrumenter`, from @stryker-mutator/instrumenter: the library Stryker's
 *   core calls to parse the files to mutate (Babel), generate the mutants and
 *   compile all of them into the code at once ("mutant switching"). Unchanged.
 * * `ClearTextReporter`, from @stryker-mutator/core: the reporter that prints
 *   Stryker's report on a terminal, the mutants and the score table. Its
 *   module, imported by path because the package exports only its CLI's
 *   entry; unchanged.
 * * `calculateMutationTestMetrics`, from mutation-testing-metrics: what
 *   Stryker's core gives that reporter, computed from the report.
 * * `chalk`, the copy the reporter colours with, so the runner can say that
 *   the terminal takes colours (its browser build guesses from the user
 *   agent).
 *
 * What none of them can do in a worker (read files, start processes) is
 * replaced at bundle time by modules that say so if called; see
 * tools/stryker.mjs for each one and why it is never reached.
 */
export { Instrumenter } from '@stryker-mutator/instrumenter';
export { ClearTextReporter } from '../../node_modules/@stryker-mutator/core/dist/src/reporters/clear-text-reporter.js';
export { calculateMutationTestMetrics } from 'mutation-testing-metrics';
export { default as chalk } from 'chalk';
