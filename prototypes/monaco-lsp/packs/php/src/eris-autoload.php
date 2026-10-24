<?php

// Eris's autoloading in a Test in the browser, standing in for what
// Composer generates from Eris's composer.json (giorgiosironi/eris 1.3.0):
// `"psr-4": {"Eris\\": "src/"}` and `"files": ["src/Generator/functions.php"]`.
// The runner unpacks Eris to /opt/yukibana/lib/eris/ with this file next to
// its src/, and autoload.php (the Test's bootstrap) requires it.

spl_autoload_register(static function (string $class): void {
    if (str_starts_with($class, 'Eris\\')) {
        $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, 5)) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }
});
require_once __DIR__ . '/src/Generator/functions.php';
