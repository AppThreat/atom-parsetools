<script lang="ts">
  // The template below contains a deliberately malformed expression
  // (`{ 1 + }`), which the Svelte parser rejects for the whole file. astgen
  // must still emit an AST for this component via the script-only fallback
  // path and record the parse failure on the AST's `errors` array.
  export let seed = 1;

  function next(): number {
    return seed * 2;
  }
</script>

<p>{next()}</p>
<p>{ 1 + }</p>
