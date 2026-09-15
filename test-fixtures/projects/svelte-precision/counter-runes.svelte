<script lang="ts">
  import { onMount } from 'svelte';

  interface CounterProps {
    initial?: number;
    label?: string;
  }

  let { initial = 0, label = 'Counter' }: CounterProps = $props();

  let count = $state(initial);
  let doubled = $derived(count * 2);
  let banner = $derived(count > 10 ? 'big' : 'small');

  function increment(): void {
    count += 1;
  }

  onMount(() => {
    console.log(`${label} mounted at ${count}`);
  });

  $effect(() => {
    document.title = `${label}: ${count}`;
  });
</script>

<h1>{label}</h1>
<p>count is {count}, doubled is {doubled}</p>

{#if count > 10}
  <p class="big">Way up high: {banner}</p>
{:else if count > 5}
  <p class="mid">Getting there</p>
{:else}
  <p class="low">Keep clicking</p>
{/if}

<button onclick={increment}>Add one</button>
<div class="preview">{@html `<strong>${label}</strong>`}</div>
