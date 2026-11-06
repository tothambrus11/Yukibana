/**
 * SPDX-License-Identifier: MIT
 */
import { EOL } from 'node:os';
import type { OxfmtConfig } from 'oxfmt';

export default {
    tabWidth: 4,
    singleQuote: true,
    jsxSingleQuote: true,
    printWidth: 180,
    arrowParens: 'avoid',
    // The platform's line ending, which Git checks text files out with (see .gitattributes).
    endOfLine: EOL === '\r\n' ? 'crlf' : 'lf',
    sortPackageJson: false,
    // The imported cloud, CLI and its library keep their own formatting until they are reformatted with this config.
    ignorePatterns: ['**/*.md', 'cloud/**', 'packages/cli/**', 'packages/client/**', 'docs/cloud/**'],
    overrides: [
        {
            files: ['*.json', '*.code-snippets', '*.yml', '*.yaml'],
            options: { tabWidth: 2 },
        },
    ],
} satisfies OxfmtConfig;
