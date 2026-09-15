<script lang="ts">
  // TypeScript is allowed in template expressions only when the instance
  // script declares lang="ts"; this component pins that path.
  import type { Note } from './types.ts';

  let { note }: { note: Note } = $props();

  function normalize(value: unknown): string {
    return String(value).trim();
  }
</script>

<p>{(note.body as string).length} chars</p>
<p>{normalize(note.body!).toUpperCase()}</p>
