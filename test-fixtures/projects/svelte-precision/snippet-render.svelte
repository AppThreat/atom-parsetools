<script lang="ts">
  import type { Item } from './types.ts';

  let { items }: { items: Item[] } = $props();
</script>

{#snippet row(index: number, item: Item)}
  <tr>
    <td>{index}</td>
    <td>{item.title}</td>
  </tr>
{/snippet}

<table>
  <tbody>
    {#each items as item, i (item.id)}
      {@render row(i, item)}
    {/each}
  </tbody>
  <svelte:fragment slot="summary">
    <slot name="footer" let:compact>
      <caption>{compact ? 'compact' : 'full'} listing</caption>
    </slot>
  </svelte:fragment>
</table>
