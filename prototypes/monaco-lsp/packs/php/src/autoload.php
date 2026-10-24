<?php

// The bootstrap of a Test in the browser, standing in for Composer's
// vendor/autoload.php: a class map of the project, as Composer's
// `"autoload": {"classmap": ["./"]}` builds one (the composer.json the
// app's Download generates says the same), so a test can use the project's
// classes, interfaces, traits and enums without requiring their files.
//
// The map covers every .php file in the working directory (the project)
// outside tests/ and vendor/; a declaration is found with PHP's own
// tokenizer, so nothing is run to find it. Files that only declare
// functions cannot be autoloaded, by Composer either: a test requires them.
//
// Libraries the runner installed for this Test (Eris, for a project that
// uses it) are under /opt/yukibana/lib/<name>/, each with an autoload.php
// that does what its Composer autoload section says; they are loaded first.

foreach (glob('/opt/yukibana/lib/*/autoload.php') ?: [] as $library) {
    require_once $library;
}

(static function (): void {
    $root = getcwd();
    $map = [];
    $files = new RecursiveIteratorIterator(new RecursiveCallbackFilterIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        static function (SplFileInfo $file) use ($root): bool {
            $relative = substr($file->getPathname(), strlen($root) + 1);
            if ($file->isDir()) {
                return !in_array($relative, ['tests', 'vendor'], true) && $file->getFilename()[0] !== '.';
            }
            return $file->getExtension() === 'php';
        },
    ));
    foreach ($files as $file) {
        $path = $file->getPathname();
        try {
            $tokens = token_get_all((string) file_get_contents($path), TOKEN_PARSE);
        } catch (ParseError) {
            continue; // PHPUnit reports it when the file is loaded.
        }
        $namespace = '';
        $count = count($tokens);
        for ($i = 0; $i < $count; $i++) {
            $token = $tokens[$i];
            if (!is_array($token)) {
                continue;
            }
            if ($token[0] === T_NAMESPACE) {
                $namespace = '';
                for ($j = $i + 1; $j < $count && is_array($tokens[$j]); $j++) {
                    if (in_array($tokens[$j][0], [T_NAME_QUALIFIED, T_STRING], true)) {
                        $namespace = $tokens[$j][1] . '\\';
                        break;
                    }
                }
            } elseif (in_array($token[0], [T_CLASS, T_INTERFACE, T_TRAIT, T_ENUM], true)) {
                // `Foo::class` and `new class` are not declarations.
                $previous = $i - 1;
                while ($previous >= 0 && is_array($tokens[$previous]) && $tokens[$previous][0] === T_WHITESPACE) {
                    $previous--;
                }
                if ($previous >= 0 && (($tokens[$previous][0] ?? null) === T_DOUBLE_COLON || ($tokens[$previous][0] ?? null) === T_NEW)) {
                    continue;
                }
                for ($j = $i + 1; $j < $count; $j++) {
                    if (is_array($tokens[$j]) && $tokens[$j][0] === T_STRING) {
                        $map[strtolower($namespace . $tokens[$j][1])] ??= $path;
                        break;
                    }
                    if (!is_array($tokens[$j]) || $tokens[$j][0] !== T_WHITESPACE) {
                        break;
                    }
                }
            }
        }
    }
    spl_autoload_register(static function (string $class) use ($map): void {
        $file = $map[strtolower($class)] ?? null;
        if ($file !== null) {
            require_once $file;
        }
    });
})();
