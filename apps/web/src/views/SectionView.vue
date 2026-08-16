<script setup lang="ts">
defineProps<{ description: string; title: string }>();
</script>

<template>
  <section :aria-labelledby="`${title}-title`">
    <p class="mb-2 text-sm font-medium text-base-content/60">Journal</p>
    <h1
      :id="`${title}-title`"
      class="text-3xl font-bold tracking-tight sm:text-4xl"
    >
      {{ title }}
    </h1>
    <p class="mt-3 max-w-2xl text-base-content/70">{{ description }}</p>
    <div class="alert mt-8" role="status">
      <span
        >This area is part of the application shell and will be enabled by its
        feature phase.</span
      >
    </div>
  </section>
</template>
