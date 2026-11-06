/**
 * SPDX-License-Identifier: MIT
 */
import { defineConfig } from 'vitest/config';

/** The IDE's unit tests: every spec of the extensions and their common library, run from the sources. */
export default defineConfig({
    test: {
        include: ['ide/{common,extensions/*}/src/**/*.spec.ts'],
        setupFiles: ['./ide/configs/vitest.setup.ts'],
        coverage: {
            provider: 'v8',
            include: ['ide/{common,extensions/*}/src/**/*.{ts,tsx}'],
            exclude: ['**/*.spec.ts', '**/typings/**'],
            reporter: ['text', 'html', 'lcov'],
        },
    },
});
