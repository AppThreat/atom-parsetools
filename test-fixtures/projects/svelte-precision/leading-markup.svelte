<!-- Markup before <script> is legal Svelte: the compiler hoists the instance
     script, so this still renders after `label` is initialised.

     This file exists to pin the ordering contract. The root fragment's first child
     is this comment, at offset 0, so ordering program.body by offset would place the
     template statement ahead of the script - inverting the control flow a consumer
     derives from it. The template statement must always come last. -->
<p data-role="lead">{label}</p>

<script lang="ts">
  export let label: string = "lead";

  const shout = (value: string): string => value.toUpperCase();

  export const shouted: string = shout(label);
</script>

<footer>{shouted}</footer>
