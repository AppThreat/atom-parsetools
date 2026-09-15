// A `.svelte.ts` module: runes outside a component file. astgen treats it as
// plain TypeScript for parsing; the Svelte rune declarations are provided by
// the same shim set used for `.svelte` type maps.
export function createCounter(initial = 0) {
  let count = $state(initial);
  let history = $state<number[]>([]);

  function increment(): number {
    history = [...history, count];
    count += 1;
    return count;
  }

  function undo(): number {
    const previous = history[history.length - 1];
    if (previous !== undefined) {
      count = previous;
      history = history.slice(0, -1);
    }
    return count;
  }

  return {
    get count(): number {
      return count;
    },
    increment,
    undo
  };
}

export const STEP_LIMIT = 100;
