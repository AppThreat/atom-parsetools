<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';

  // Svelte 4 style component: reactive `export let` props and `$:` statements
  // instead of runes. The Svelte 5 compiler still parses these.
  export let threshold = 5;
  export let items: string[] = [];

  $: total = items.length;
  $: aboveThreshold = total >= threshold;

  const dispatch = createEventDispatcher<{ crossed: { total: number } }>();

  function handleClick(): void {
    dispatch('crossed', { total });
  }

  onMount(() => {
    console.log(`started with ${total} items`);
  });
</script>

<p>{total} of {threshold}</p>
<button on:click={handleClick} disabled={!aboveThreshold}>
  {aboveThreshold ? 'over' : 'under'}
</button>
<ul>
  {#each items as item, i}
    <li>{i + 1}. {item}</li>
  {/each}
</ul>
