<script setup lang="ts">
import { computed, ref } from "vue";

type Theme = "light" | "dark";

const count = ref<number>(0);
const step = ref(2);
const theme = ref<Theme>("light");

const doubled = computed(() => count.value * 2);
const label = computed(() => `${theme.value}:${doubled.value}`);

function increment(): number {
  count.value += step.value;
  return count.value;
}

const snapshot = {
  current: count.value,
  activeTheme: theme.value
};
</script>

<template>
  <button @click="increment">{{ label }}</button>
</template>
