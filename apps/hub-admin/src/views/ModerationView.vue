<script setup lang="ts">
import { Badge, Button, Empty, Hint, Panel, useToast } from '@conference-operator/components'
import { timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { useModerationStore } from '../stores/moderation.js'

/**
 * Wall moderation.
 *
 * Nothing reaches a room screen without passing through here, which is why the
 * two buttons are far apart in weight rather than side by side in the same one:
 * publishing is the deliberate act, rejecting is the reflex.
 *
 * The `id`s below are kept from the string template on purpose. They are a
 * three-headed contract — the tests address them, the preview scripts click
 * them, and somebody debugging in a corridor during an event types them into a
 * console. Renaming them is a separate decision from migrating the view.
 */
const store = useModerationStore()
const { pending, loading } = storeToRefs(store)
const toast = useToast()

async function decide(id: string, decision: 'approve' | 'reject'): Promise<void> {
  try {
    await store.moderate(id, decision)
    toast.say(decision === 'approve' ? 'Message publié.' : 'Message rejeté.')
  } catch {
    // The hub client already raised the failure through `onError`; saying it
    // twice would stack two notices for one cause.
  }
}
</script>

<template>
  <div
    id="moderation-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] items-start gap-3.5"
  >
    <Panel class="col-span-full" title="Modération du mur">
      <Hint class="mt-0 mb-3.5">
        Rien n'atteint un écran de salle sans passer par ici : ces messages sont
        projetés devant le public.
      </Hint>

      <div id="moderation">
        <Empty v-if="pending.length === 0 && !loading">Rien à relire.</Empty>

        <article
          v-for="message in pending"
          :key="message.id"
          class="mb-2.5 rounded-[9px] border border-edge p-3"
          :data-message="message.id"
        >
          <div class="mb-1.5 flex items-center gap-2 text-xs text-dim">
            <Badge class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">{{ message.source }}</Badge>
            <span>{{ message.author }}</span>
            <span>{{ timeAgo(message.createdAt) }}</span>
          </div>
          <p class="mb-2.5 text-sm leading-snug break-words">{{ message.text }}</p>
          <div class="flex gap-2">
            <Button variant="primary" size="small" @click="decide(message.id, 'approve')">
              Publier
            </Button>
            <Button variant="danger" size="small" @click="decide(message.id, 'reject')">
              Rejeter
            </Button>
          </div>
        </article>
      </div>
    </Panel>
  </div>
</template>
