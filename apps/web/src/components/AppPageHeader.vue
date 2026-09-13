<script setup lang="ts">
defineProps<{
  description?: string;
  eyebrow: string;
  title: string;
  titleId: string;
}>();
</script>

<template>
  <header
    class="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"
  >
    <div class="min-w-0">
      <p class="mb-2 text-sm font-semibold text-base-content/60">
        {{ eyebrow }}
      </p>
      <h1 :id="titleId" class="text-3xl font-bold tracking-tight sm:text-4xl">
        {{ title }}
      </h1>
      <p v-if="description" class="mt-3 max-w-3xl text-base-content/70">
        {{ description }}
      </p>
      <slot name="meta" />
    </div>

    <div v-if="$slots.actions" class="shrink-0">
      <slot name="actions" />
    </div>
  </header>
</template>
