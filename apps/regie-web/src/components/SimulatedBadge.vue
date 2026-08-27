<script setup lang="ts">
/**
 * Rien ne distingue à l'écran un enregistrement simulé d'un vrai : mêmes
 * boutons, même chronomètre, même sidecar écrit. La seule différence est
 * qu'aucune caméra n'est branchée derrière — d'où ce rappel partout où l'on
 * croit piloter OBS.
 */
defineProps<{ when: boolean }>()
</script>

<template>
  <span
    v-if="when"
    class="ml-1.5 rounded border border-attention/40 px-1 py-px text-[10px] font-semibold tracking-[.08em] text-attention uppercase"
  >
    simulé
  </span>
</template>
