<script setup lang="ts">
import { ref } from "vue";

const rawHtml = ref("<b>trusted?</b>");
const user = ref({ name: "ada", homepage: "https://example.com" });
const query = ref("");
const items = ref([{ id: 1, name: "one" }, { id: 2, name: "two" }]);

function clearQuery(): string {
  query.value = "";
  return query.value;
}
</script>

<template>
  <div title="plain attribute stays a string">
    <p v-html="rawHtml"></p>
    <a :href="user.homepage" :title="'static title'">{{ user.name }}</a>
    <input v-model="query" @click="clearQuery" />
    <li v-for="item in items" :key="item.id">
      <span v-html="item.name">{{ item.name }}</span>
    </li>
  </div>
</template>
