<template>
  <button @click="inc">{{ label }} {{ count }}</button>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
const props = defineProps<{ start: number; title: string }>();
const count = ref(props.start);
const label = computed(() => props.title.toUpperCase());
function inc() { count.value++; }
</script>

<style scoped>
button { color: red; }
</style>
