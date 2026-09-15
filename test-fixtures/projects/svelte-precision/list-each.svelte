<script lang="ts">
  import type { Row } from './types.ts';

  let { rows }: { rows: Row[] } = $props();

  function total(rows: Row[]): number {
    return rows.reduce((sum, row) => sum + row.score, 0);
  }
</script>

<ul>
  {#each rows as { id, name, score }, index (id)}
    {@const scaled = score * 10}
    <li data-index={index}>
      {name}: {scaled}
      {#each [1, 2] as factor}
        <small> x{factor} </small>
      {/each}
    </li>
  {:else}
    <li class="empty">No rows yet</li>
  {/each}
</ul>
<footer>{total(rows)}</footer>
