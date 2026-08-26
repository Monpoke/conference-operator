<script setup lang="ts">
import { Badge, Button, Toaster } from '@cloudnord/components'
import { storeToRefs } from 'pinia'
import { onScopeDispose, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ConsoleNav from './components/ConsoleNav.vue'
import SignInScreen from './components/SignInScreen.vue'
import { useSessionStore } from './stores/session.js'

/**
 * The console's shell, and its single polling loop.
 *
 * One loop reading `route.meta.refresh` replaces a thirty-line `if/else if`
 * that had to be extended by hand for every view — and where forgetting a
 * branch meant that view simply never refreshed, silently. Two things fall out
 * of it for free: a hidden tab stops polling, and a view loads immediately
 * instead of waiting for the next tick.
 */
const session = useSessionStore()
const { signedIn, eventName, mode } = storeToRefs(session)
const route = useRoute()

const timer = ref<ReturnType<typeof setTimeout> | null>(null)

function stop(): void {
  if (timer.value != null) clearTimeout(timer.value)
  timer.value = null
}

/**
 * `setTimeout` chained, not `setInterval`.
 *
 * The interval counts from the *end* of the request. With `setInterval`, a hub
 * answering slower than the period stacked calls on top of each other, which is
 * exactly when it could least afford them.
 */
async function tick(): Promise<void> {
  const { refresh, intervalMs } = route.meta
  if (refresh == null || !signedIn.value) return
  if (document.visibilityState === 'visible') {
    try {
      await refresh()
    } catch {
      // Already reported through the client's error hook.
    }
  }
  stop()
  timer.value = setTimeout(() => void tick(), intervalMs ?? 10_000)
}

watch(
  [() => route.fullPath, signedIn],
  () => {
    stop()
    void tick()
  },
  { immediate: true },
)

onScopeDispose(stop)
</script>

<template>
  <SignInScreen v-if="!signedIn" />

  <div v-else id="console" class="min-h-dvh">
    <header class="flex flex-wrap items-center gap-3 px-4 py-3">
      <h1 class="text-[15px] font-semibold">{{ eventName }}</h1>
      <Badge v-if="mode !== 'production'" id="badge-mode" variant="warning">{{ mode }}</Badge>
      <div class="ml-auto">
        <Button id="btn-deconnexion" size="small" @click="session.signOut()">Se déconnecter</Button>
      </div>
    </header>

    <ConsoleNav />

    <main class="p-4">
      <RouterView />
    </main>
  </div>

  <Toaster />
</template>
