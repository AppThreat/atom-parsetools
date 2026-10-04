<?php

// Parses many PHP files in one interpreter run, each exactly as
// `php-parse --with-recovery --resolve-names -P --json-dump <file>` parses one. phpastgen hands
// every worker a chunk of files, so a large tree costs a few interpreter starts rather than one per
// file, which is what makes vendored trees affordable where starting a process is slow (Windows).
//
// Usage: php phpbatch.php <autoload.php> <manifest.json> [<target version>]
//
// The manifest is a JSON array of [source, output] pairs. Each source's statement array is written
// as JSON to its output, and one status line per pair is printed as soon as it is done:
//   ok<TAB><index>
//   fail<TAB><index><TAB><JSON-encoded message>
// A pair without a status line was never finished (the interpreter died on it, or on an earlier
// pair) and is left to the caller.

ini_set('display_errors', 'stderr');
ini_set('xdebug.max_nesting_level', 3000);

if ($argc < 3) {
    fwrite(STDERR, "Usage: php phpbatch.php <autoload.php> <manifest.json> [<target version>]\n");
    exit(2);
}
require $argv[1];

$pairs = json_decode((string) @file_get_contents($argv[2]), true);
if (!is_array($pairs)) {
    fwrite(STDERR, "Unreadable manifest {$argv[2]}\n");
    exit(2);
}

$version = isset($argv[3]) && $argv[3] !== ''
    ? PhpParser\PhpVersion::fromString($argv[3])
    : PhpParser\PhpVersion::getNewestSupported();
$parser = (new PhpParser\ParserFactory())->createForVersion($version);
$traverser = new PhpParser\NodeTraverser();
$traverser->addVisitor(new PhpParser\NodeVisitor\NameResolver);

function report(string $line): void
{
    echo $line, "\n";
    flush();
}

function fail(int $index, string $message): void
{
    report("fail\t$index\t" . json_encode($message, JSON_INVALID_UTF8_SUBSTITUTE));
}

foreach ($pairs as $index => $pair) {
    [$source, $output] = $pair;
    $code = @file_get_contents($source);
    if ($code === false) {
        fail($index, "File $source does not exist.");
        continue;
    }
    try {
        $errorHandler = new PhpParser\ErrorHandler\Collecting;
        $stmts = $parser->parse($code, $errorHandler);
        $messages = array_map(
            static fn ($error) => $error->getMessage(),
            $errorHandler->getErrors()
        );
        if ($stmts === null) {
            fail($index, implode("\n", $messages));
            continue;
        }
        $stmts = $traverser->traverse($stmts);
        // php-parse fails the whole file when a string literal holds bytes that are not UTF-8
        // ("\x80" escapes, binary fixtures); substituting them keeps the file's AST.
        $json = json_encode($stmts, JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE);
    } catch (Throwable $e) {
        // php-parse dies on these (a name resolution conflict, say); here they cost only this file.
        fail($index, $e->getMessage());
        continue;
    }
    if ($json === false) {
        fail($index, json_last_error_msg());
        continue;
    }
    if (@file_put_contents($output, $json) === false) {
        fail($index, "Unable to write $output");
        continue;
    }
    unset($stmts, $json, $code);
    report("ok\t$index");
}
