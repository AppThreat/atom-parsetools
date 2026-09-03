<?php

namespace App\Tests;

// Files under tests/ are dropped by the default exclusion regex ^(tests?|vendor|Tests?),
// so this must land in files_excluded and never produce an AST.
class MathTest
{
    public function testAdd(): void
    {
        assert(1 + 1 === 2);
    }
}
