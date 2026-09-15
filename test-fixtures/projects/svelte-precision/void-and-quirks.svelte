<script lang="ts">
  let tone = $state('warm');
  let name = $state('fixture');
</script>

<!-- HTML comments are dropped from the emitted AST by design. -->
<div
  class="greeting tone-{tone} name-{name} plain"
  data-note="a > b inside quotes"
  data-end="value-{name}"
  data-start="{tone}-lead"
  data-adjacent="{tone}{name}"
>
  <br>
  <img src="/logo.svg" alt="logo">
  <input type="checkbox" checked>
  <textarea rows={3} bind:value={name} ></textarea>
</div>
<span>{name}</span>
