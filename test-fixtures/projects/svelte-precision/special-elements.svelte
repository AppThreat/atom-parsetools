<script lang="ts">
  import Child from './snippet-render.svelte';

  let heading = $state('Special elements');
  let tag = $state<'b' | 'i'>('b');
  let broken = $state<Error | null>(null);
</script>

<svelte:head>
  <title>{heading} — fixture</title>
  <meta name="fixture" content="special-elements" />
</svelte:head>

<svelte:window on:keydown={(e) => console.log(e.key)} />

<svelte:body on:click={() => console.log('body click')} />

<svelte:document on:fullscreenchange={() => console.log('fullscreen')} />

<h2>{heading}</h2>

<svelte:element this={tag}>dynamic tag</svelte:element>

<svelte:boundary onerror={(e) => (broken = e)}>
  <Child items={[]} />
  <p class:failed={broken !== null}>{broken?.message ?? 'ok'}</p>
</svelte:boundary>
