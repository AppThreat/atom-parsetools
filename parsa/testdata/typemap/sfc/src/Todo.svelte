<script lang="ts">
  let todos = $state([{ id: 1, text: 'a', done: false }]);
  let remaining = $derived(todos.filter((t) => !t.done).length);
  function add(text: string) { todos.push({ id: todos.length + 1, text, done: false }); }
</script>

<ul>
  {#each todos as todo}
    <li class:done={todo.done}>{todo.text}</li>
  {/each}
</ul>
<p>{remaining} left</p>
