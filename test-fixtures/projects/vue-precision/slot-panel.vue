<script setup lang="ts">
import { computed } from "vue";

interface SlotRow {
  id: string;
  score: number;
}

const props = defineProps<{ rows: Array<SlotRow> }>();
const slots = defineSlots<{
  default(props: { row: SlotRow; index: number }): unknown;
  footer?(props: { total: number }): unknown;
}>();

const totalScore = computed(() =>
  props.rows.reduce((sum, row) => sum + row.score, 0)
);

const firstRow = computed(() => props.rows[0]);

function hasFooterSlot(): boolean {
  return typeof slots.footer === "function";
}
</script>

<template>
  <div>
    <slot
      v-for="(row, index) in props.rows"
      :key="row.id"
      :row="row"
      :index="index"
    />
    <slot name="footer" :total="totalScore" />
  </div>
</template>
