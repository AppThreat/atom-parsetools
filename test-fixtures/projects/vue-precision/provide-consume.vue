<script setup lang="ts">
import { computed, inject, provide, ref, type InjectionKey } from "vue";

interface Session {
  id: string;
  role: "admin" | "user";
}

const SessionKey = Symbol("session") as InjectionKey<Session>;

const currentSession = ref<Session>({ id: "u-1", role: "admin" });
provide(SessionKey, currentSession.value);

const injectedSession = inject(SessionKey, currentSession.value);
const isAdmin = computed(() => injectedSession.role === "admin");

function switchRole(): Session["role"] {
  const nextRole = injectedSession.role === "admin" ? "user" : "admin";
  currentSession.value = { ...currentSession.value, role: nextRole };
  return nextRole;
}
</script>

<template>
  <p>{{ isAdmin ? 'admin' : 'user' }}</p>
  <button @click="switchRole">Switch</button>
</template>
