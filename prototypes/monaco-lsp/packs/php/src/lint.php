<?php

// Replaces Phpactor's PhpLinter (lib/Extension/LanguageServerDiagnostics/
// Model/PhpLinter.php), which pipes the document into a `php -l` child
// process, as a diagnostics provider named "php". In the browser there are
// no child processes, so this one parses the document with the PHP that
// runs Phpactor: token_get_all() with TOKEN_PARSE runs the real PHP 8.4
// parser and throws the ParseError `php -l` would print. The difference:
// `php -l` also compiles, so the errors PHP finds only while compiling
// ("Cannot redeclare", "Cannot use [] for reading", a `break` outside a loop)
// are not reported here; they show when the program runs.
//
// The class has upstream's name, constructor and method, so the extension
// that registers the provider uses it unchanged. It must be loaded before
// Composer's autoloader would load upstream's (phpactor.php).

namespace Phpactor\Extension\LanguageServerDiagnostics\Model;

use Amp\Promise;
use Amp\Success;
use Phpactor\LanguageServerProtocol\Diagnostic;
use Phpactor\LanguageServerProtocol\DiagnosticSeverity;
use Phpactor\LanguageServerProtocol\Position;
use Phpactor\LanguageServerProtocol\Range;
use Phpactor\TextDocument\TextDocument;
use Phpactor\TextDocument\Util\LineColRangeForLine;

final class PhpLinter
{
    public function __construct(private string $phpBin)
    {
    }

    /**
     * @return Promise<Diagnostic[]>
     */
    public function lint(TextDocument $textDocument): Promise
    {
        $text = $textDocument->__toString();
        try {
            token_get_all($text, TOKEN_PARSE);
            return new Success([]);
        } catch (\ParseError $e) {
            // The whole line, as upstream marks it: PHP reports a line only.
            $line = max(1, $e->getLine());
            $range = (new LineColRangeForLine())->rangeFromLine($text, $line);
            return new Success([
                new Diagnostic(
                    range: new Range(
                        new Position($line - 1, $range->start()->col() - 1),
                        new Position($line - 1, $range->end()->col() - 1)
                    ),
                    message: 'PHP Parse error: ' . $e->getMessage(),
                    severity: DiagnosticSeverity::ERROR,
                    source: 'php',
                ),
            ]);
        }
    }
}
