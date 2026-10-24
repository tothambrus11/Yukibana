// Copied by build.sh into the upstream checkout at
// packages/browser-pyright/src-yukibana/, so that module resolution, the
// TypeScript project and the node polyfills are exactly upstream's own
// browser-pyright setup (packages/browser-pyright/rspack.config.js). What
// differs from upstream's config, and why:
//  * entry is our server.ts (contract transport, no boot protocol, lazy stubs)
//  * no `typeshed-json` virtual module: the stubs ship as a separate tar.gz
//  * only English messages: the 14 other locales are ~1.4 MB of JSON; pyright
//    falls back to English for keys a locale map lacks, so an empty map is safe
//  * an ES module (the app starts packs with `{ type: 'module' }`), no source map
const path = require('path');
const { DefinePlugin, NormalModuleReplacementPlugin, ProvidePlugin } = require('@rspack/core');
const { tsconfigResolveAliases } = require('../../../build/lib/webpack');

module.exports = (_, { mode }) => ({
    context: __dirname,
    target: 'webworker',
    entry: { server: './server.ts' },
    optimization: { minimize: mode === 'production' },
    output: {
        filename: '[name].js',
        path: process.env.PACK_OUT,
        module: true,
        chunkFormat: 'module',
        clean: false,
    },
    devtool: false,
    stats: { all: false, errors: true, warnings: true },
    resolve: {
        extensions: ['.ts', '.js'],
        // server.ts uses vscode-languageserver-textdocument, a dependency of
        // pyright-internal that browser-pyright does not declare itself.
        modules: ['node_modules', path.resolve(__dirname, '../../pyright-internal/node_modules')],
        // upstream's tsconfig maps pyright-internal/* to ../pyright-internal/src/*
        alias: tsconfigResolveAliases(path.join(__dirname, '..', 'tsconfig.json')),
        // Same as upstream: pyright's node-only modules are never reached in the browser.
        fallback: {
            buffer: require.resolve('buffer/'),
            child_process: false,
            crypto: false,
            path: require.resolve('path-browserify'),
            stream: false,
            fs: false,
            os: false,
            v8: false,
        },
    },
    module: {
        rules: [{ test: /\.ts$/, loader: 'ts-loader', options: { configFile: path.join(__dirname, 'tsconfig.json') } }],
    },
    plugins: [
        new DefinePlugin({
            // As upstream: just enough of `process` for program.ts's memory check and is-ci.
            process: { env: {}, execArgv: [], cwd: () => '/', memoryUsage: () => ({ heapUsed: 0, rss: 1 }) },
        }),
        new ProvidePlugin({ Buffer: ['buffer', 'Buffer'] }),
        new NormalModuleReplacementPlugin(
            /package\.nls\.(?!en-us\.json$)[a-z-]+\.json$/,
            path.join(__dirname, 'empty-locale.json')
        ),
    ],
});
