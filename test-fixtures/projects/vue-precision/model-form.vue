<script setup lang="ts">
import { computed } from "vue";

const modelValue = defineModel<string>({ required: true });

type FieldState = {
  dirty: boolean;
  minLength: number;
};

const fieldState = computed<FieldState>(() => ({
  dirty: modelValue.value.length > 0,
  minLength: 3
}));

const normalizedModel = computed(() => modelValue.value.trim().toLowerCase());
const isValid = computed(() => normalizedModel.value.length >= fieldState.value.minLength);

const tokens = computed(() => normalizedModel.value.split("-").filter(Boolean));

function appendSegment(segment: string): string {
  const safeSegment = segment.trim().toLowerCase();
  modelValue.value = safeSegment
    ? `${normalizedModel.value}-${safeSegment}`
    : normalizedModel.value;
  return modelValue.value;
}

function resetModel(): string {
  modelValue.value = "";
  return modelValue.value;
}
</script>

<template>
  <input v-model="modelValue" />
  <p>{{ normalizedModel }}</p>
  <p>{{ isValid ? 'valid' : 'invalid' }}</p>
  <p>{{ tokens.length }}</p>
  <button @click="appendSegment('next')">Append</button>
  <button @click="resetModel">Reset</button>
</template>
