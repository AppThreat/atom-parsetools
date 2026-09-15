<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { tooltip } from './api-client.ts';
  import type { PanelState } from './types.ts';

  let { visible = true, panels }: { visible?: boolean; panels: PanelState[] } = $props();

  let query = $state('');
  let outerWidth = $state(0);
  let firstPanel = $state<HTMLElement | null>(null);

  const keys = (node: HTMLElement, options: { hotkey: string }) => {
    console.log(node, options.hotkey);
  };
</script>

<svelte:window bind:outerWidth on:resize={() => (outerWidth = window.outerWidth)} />

<input
  bind:value={query}
  class:filled={query.length > 0}
  style:color={query ? 'red' : 'blue'}
  use:tooltip={{ text: query }}
  use:keys={{ hotkey: 'k' }}
/>

{#if visible}
  <div
    transition:fade={{ duration: 150 }}
    in:fly={{ x: 20, duration: 200 }}
    out:fly={{ x: -20, duration: 200 }}
    {...panels[0]}
  >
    {#each panels as panel (panel.id)}
      <label animate:flip={{ duration: 200 }}>
        <input type="checkbox" bind:checked={panel.open} on:change|preventDefault={() => console.log(panel.id)} />
        {panel.id}
      </label>
    {/each}
  </div>
{/if}

<img src="/panels.png" alt="panels" width={outerWidth} {visible} />
