<?php

namespace App;

function greet(string $name): string
{
    return "Hello, " . $name;
}

class Greeter
{
    public function __construct(private string $prefix = "Hi")
    {
    }

    public function greet(string $name): string
    {
        return $this->prefix . ", " . $name;
    }
}

echo greet("world");
