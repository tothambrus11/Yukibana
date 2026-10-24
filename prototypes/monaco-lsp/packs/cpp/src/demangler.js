// LLVM's Itanium demangler, demangle.wasm (build-demangle.sh): what
// llvm-cxxfilt and llvm-symbolizer run on a _Z name. The compiler output
// views (explorer.js) demangle their assembly with it, and the runner a
// sanitizer's report from a Linux guest (runner-linux.js, sanitizer.js).

/**
 * Loads demangle.js from `base` and compiles demangle.wasm, fetched through
 * `download(name)` (a toolchain's, for its progress messages), and resolves
 * to `demangle(names)`: an array of names in, their demangled forms out in
 * the same order (a name it cannot demangle comes back as it was).
 * Rejects when either cannot be loaded or the module will not start.
 */
export async function loadDemangler(base, download) {
    const [{ default: create }, response] = await Promise.all([
        import(new URL('demangle.js', base).href),
        download('demangle.wasm'),
    ]);
    const module = await WebAssembly.compile(await response.arrayBuffer());
    // Emscripten's create() waits for done() and never hears that
    // instantiation failed; the failure rejects this instead (as in
    // toolchain.tool), or every later request would wait forever.
    let failed;
    const failure = new Promise((_, reject) => (failed = reject));
    const mod = await Promise.race([
        create({
            instantiateWasm(imports, done) {
                WebAssembly.instantiate(module, imports).then(
                    (instance) => done(instance, module),
                    (error) => failed(new Error(`demangle.wasm could not start: ${error?.message ?? error}`)));
                return {};
            },
        }),
        failure,
    ]);
    return (names) => {
        const input = mod.stringToNewUTF8(names.join('\n'));
        const output = mod._yk_demangle_lines(input);
        mod._free(input);
        if (!output) return names;
        const text = mod.UTF8ToString(output);
        mod._free(output);
        return text.split('\n');
    };
}
