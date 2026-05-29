<script setup lang="ts">
import { computed } from "vue";

interface UserRecord {
  id: string;
  name: string;
}

type ModalProps<TPayload> = {
  title: string;
  payload: TPayload;
  visible?: boolean;
};

const props = withDefaults(defineProps<ModalProps<UserRecord>>(), {
  visible: true
});

const emit = defineEmits<{
  close: [reason: "confirm" | "cancel"];
}>();

const titleLabel = computed(() => `${props.title}-${props.payload.name}`);

function closeModal(reason: "confirm" | "cancel"): void {
  emit("close", reason);
}
</script>

<template>
  <section v-if="props.visible">
    <h2>{{ titleLabel }}</h2>
    <button @click="closeModal('confirm')">Confirm</button>
  </section>
</template>
