<?php

namespace App;

class Math
{
    public function add(int $a, int $b): int
    {
        return $a + $b;
    }

    public function factorial(int $n): int
    {
        if ($n <= 1) {
            return 1;
        }
        return $n * $this->factorial($n - 1);
    }
}
