<?php

namespace App;

// This file exists so the contract snapshot always sees a `framework_facts` key:
//  - the `#[Route("/x")]` attribute group yields `{ attributes: [...] }`, and
//  - the `$_GET[...]` superglobal reference yields `{ superglobal, request }`.
class Controller
{
    #[Route("/x")]
    public function index(): string
    {
        $id = $_GET["id"];
        return "id=" . $id;
    }
}
