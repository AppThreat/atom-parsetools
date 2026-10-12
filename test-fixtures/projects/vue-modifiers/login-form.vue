<script setup lang="ts">
import { ref } from 'vue'

const email = ref('')
const notice = ref('')
const target = ref('/')

function submit() {
  // Full reload so the server-rendered pages pick up the new cookie.
  window.location.assign(target.value)
}
</script>

<template>
  <form @submit.prevent="submit" :aria-label="'Sign in'">
    <input v-model.trim="email" type="email" @keydown.enter.exact="submit" />
    <button v-on:click.stop="submit" @update:model-value="submit">Sign in</button>
    <slot-list>
      <template #default="{ item }">{{ item }}</template>
    </slot-list>
    <p class="notice" v-html="notice"></p>
  </form>
</template>
