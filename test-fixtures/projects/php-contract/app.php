<?php

namespace App;

// A plain good file so the snapshot pins the AST wrapper's required key set on a
// file that carries only rel_file_path (no encoding scrub, no truncation).
function greet(string $name): string
{
    return "Hello, " . $name;
}
