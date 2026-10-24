<?php

// Starts Phpactor in php-wasm, the way upstream's bin/phpactor starts it,
// minus what the browser cannot do. Upstream's files are not modified: this
// file is run instead of bin/phpactor, and replaces three upstream classes
// before the autoloader can load them (lint.php, rename.php, and
// WorseSignatureHelper.php, which build.sh writes from upstream's with one
// method changed by scripts/patch-signature-helper.php).
//
//   php /opt/yukibana/phpactor.php language-server   (server.js)
//   php /opt/yukibana/phpactor.php index:build       (build.sh, ahead of time)
//
// * bin/phpactor refuses to start without ext-posix, which php-wasm does not
//   have. Phpactor itself calls only posix_getuid (to name a cache folder)
//   and posix_getpid (in log lines) on the paths a language server takes,
//   so those two are defined here; posix_kill, used to stop child
//   processes, stays undefined, and the features that start them are
//   turned off (CONFIG).
// * There are no processes, so the linter that runs `php -l` is replaced by
//   one that asks this PHP's own parser (lint.php).
// * A class rename needs a file for the new name, which upstream finds only
//   with Composer's autoloader (rename.php); signature help looks functions
//   up by the name as written, missing `use function` imports
//   (WorseSignatureHelper.php).
// * Configuration on top of Phpactor's defaults (CONFIG, below), given to
//   every command as --config-extra, so the index build.sh makes ahead of
//   time is the index the language server would make.

if (!function_exists('posix_getuid')) {
    function posix_getuid(): int
    {
        return 0;
    }
}
if (!function_exists('posix_getpid')) {
    function posix_getpid(): int
    {
        return 1;
    }
}

if (!getenv('PHPACTOR_DEPRECATIONS')) {
    error_reporting(\E_ALL ^ \E_DEPRECATED ^ \E_NOTICE);
}
ini_set('display_errors', 'stderr');

// Each setting turns off something that starts a process or watches a real
// file system, or says where this pack's files are:
// - diagnostics and code actions run in this process, not in a
//   `phpactor language-server:diagnostics` child process per document;
// - the indexer learns of changed files from the client
//   (workspace/didChangeWatchedFiles), not from inotify or `find`;
// - what is indexed besides the project: phpstorm-stubs (PHP's own
//   functions and classes, trimmed by build.sh to the extensions php.wasm
//   has), the source of PHPUnit's Framework namespace, from the phar the
//   runner tests with, so `extends TestCase` and `$this->assertSame` resolve,
//   and Eris's source (`use Eris\TestTrait`, `Generators::int()`), which
//   the runner installs for a project that uses it;
// - diagnostics 500 ms after the last edit rather than 1 s.
const CONFIG = [
    'language_server.diagnostic_outsource' => false,
    'language_server.code_action_outsource' => false,
    'language_server.diagnostic_sleep_time' => 500,
    'indexer.enabled_watchers' => ['lsp'],
    'indexer.stub_paths' => ['/opt/phpactor/vendor/jetbrains/phpstorm-stubs', '/opt/phpunit', '/opt/eris'],
];
$_SERVER['argv'][] = '--config-extra=' . json_encode(CONFIG);

$root = '/opt/phpactor';
require_once $root . '/vendor/autoload.php';
require_once __DIR__ . '/lint.php';
require_once __DIR__ . '/rename.php';
require_once __DIR__ . '/WorseSignatureHelper.php';

$application = new Phpactor\Application($root . '/vendor', $root . '/bin/phpactor');
$output = new Symfony\Component\Console\Output\ConsoleOutput();
try {
    $application->run(null, $output);
} catch (Exception $e) {
    $application->renderThrowable($e, $output);
    exit(255);
}
