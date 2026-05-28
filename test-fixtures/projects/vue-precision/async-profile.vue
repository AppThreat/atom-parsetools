<script setup lang="ts">
import { computed, ref } from "vue";

interface Profile {
  id: string;
  displayName: string;
  roles: Array<"admin" | "user">;
}

async function loadProfile(id: string): Promise<Profile> {
  return {
    id,
    displayName: `User-${id}`,
    roles: ["user"]
  };
}

const currentId = ref("u-100");
const profile = await loadProfile(currentId.value);
const roleSummary = computed(() => profile.roles.join(","));

function isAdmin(profileToCheck: Profile): boolean {
  return profileToCheck.roles.includes("admin");
}
</script>

<template>
  <article>
    <h3>{{ profile.displayName }}</h3>
    <p>{{ roleSummary }}</p>
    <p>{{ isAdmin(profile) ? 'admin' : 'user' }}</p>
  </article>
</template>
