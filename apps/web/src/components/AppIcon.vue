<script setup lang="ts">
export type IconName =
  | 'activity'
  | 'calendar'
  | 'exports'
  | 'memories'
  | 'menu'
  | 'processors'
  | 'search'
  | 'settings'
  | 'today';

defineProps<{ name: IconName }>();
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="size-5"
    aria-hidden="true"
  >
    <template v-if="name === 'today'">
      <path d="M4 10.5 12 4l8 6.5V20H4z" />
      <path d="M9 20v-6h6v6" />
    </template>
    <template v-else-if="name === 'calendar'">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </template>
    <template v-else-if="name === 'activity'">
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </template>
    <template v-else-if="name === 'processors'">
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" />
    </template>
    <template v-else-if="name === 'memories'">
      <path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
      <path d="M9 4v16M12 8h4" />
    </template>
    <template v-else-if="name === 'exports'">
      <path d="M12 3v12M8 11l4 4 4-4M5 20h14" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5L9 6.1a8 8 0 0 0-1.7 1l-2.4-1-2 3.4L5.1 11a7 7 0 0 0 0 2l-2.2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.5 3.1h5l.5-3.1a8 8 0 0 0 1.7-1l2.4 1 2 3.4-2.2-1.5a7 7 0 0 0 .1-1Z"
      />
    </template>
    <template v-else><path d="M4 6h16M4 12h16M4 18h16" /></template>
  </svg>
</template>
