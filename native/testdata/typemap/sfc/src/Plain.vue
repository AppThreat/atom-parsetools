<script>
export default {
  data() { return { name: 'plain', items: [1, 2, 3] }; },
  computed: { total() { return this.items.length; } }
};
</script>
<template><div>{{ name }}</div></template>
