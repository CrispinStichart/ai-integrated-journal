<script setup lang="ts">
withDefaults(
  defineProps<{
    detail: string;
    label: string;
    tone?: 'error' | 'info' | 'neutral' | 'success' | 'warning';
  }>(),
  { tone: 'neutral' },
);
</script>

<template>
  <span
    class="inline-flex items-center gap-2 text-sm"
    role="status"
    :aria-label="detail ?? label"
  >
    <span
      class="status status-sm"
      :class="{
        'status-error': tone === 'error',
        'status-info': tone === 'info',
        'status-success': tone === 'success',
        'status-warning': tone === 'warning',
      }"
      aria-hidden="true"
    />
    <span>{{ label }}</span>
  </span>
</template>
