<?php

// Deliberately broken PHP: an unterminated function body with a stray token so the
// vendored php-parse binary cannot produce an AST even with --with-recovery. This
// pins the phpastgen diagnostics behavior (Requirements 2.4, 2.7).
function busted( {
    return @@@ ;
