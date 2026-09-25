<script setup lang="ts">
import type { DisplayPayload } from '@conference-operator/contract'
import { Button, ConfirmDialog, Dialog } from '@conference-operator/components'
import { computed, ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * Where the hub's command stream stands, and the remedy when it no longer flows.
 *
 * The symptom it answers reads from anywhere but here: a phone presses a screen,
 * gets "Fait", and the room does not move; "pilotée à distance" never shows. The
 * cause is a number — the last command the room applied, above the last the hub
 * issued, once the hub has been reinstalled — and a number is only read where it
 * is written. The sync repairs it by itself; the button is for what it would not
 * see.
 */
const props = defineProps<{ payload: DisplayPayload }>()
const open = defineModel<boolean>('open', { required: true })

const actions = useActionsStore()
const confirmOpen = ref(false)

const commands = computed(() => props.payload.diagnostics?.commands ?? null)

const verdict = computed(() => {
  const c = commands.value
  if (c == null) return { tone: 'text-dim', text: 'Aucune donnée : la régie ne pilote pas ce poste.' }
  if (c.hubLast == null) {
    return {
      tone: 'text-dim',
      text: 'Le hub n’a pas encore donné sa numérotation : pas de synchronisation réussie, ou un hub plus ancien.',
    }
  }
  if (c.lastApplied > c.hubLast) {
    return {
      tone: 'text-alert',
      text: 'Désaligné : la salle attend des commandes au-delà de ce que le hub a émis. Le hub a sans doute été réinstallé, et plus rien ne passe.',
    }
  }
  return { tone: 'text-ok', text: 'Aligné : les commandes du hub arrivent jusqu’à la salle.' }
})

async function forget(): Promise<void> {
  await actions.act({ action: 'commands.forget' })
}
</script>

<template>
  <Dialog v-model:open="open" title="Diagnostic — commandes du hub" width="normal">
    <dl v-if="commands != null" class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      <dt class="text-dim">Dernière commande appliquée par la salle</dt>
      <dd class="tabular-nums" data-role="commands-last-applied">#{{ commands.lastApplied }}</dd>
      <dt class="text-dim">Dernière commande émise par le hub</dt>
      <dd class="tabular-nums" data-role="commands-hub-last">
        {{ commands.hubLast == null ? 'inconnue' : `#${commands.hubLast}` }}
      </dd>
      <dt class="text-dim">Commandes en mémoire</dt>
      <dd class="tabular-nums">{{ commands.applied }}</dd>
      <dt class="text-dim">Lien au hub</dt>
      <dd>{{ payload.state.connectivity === 'ONLINE' ? 'connecté' : 'hors ligne' }}</dd>
    </dl>

    <p class="mt-3 text-[13px]" :class="verdict.tone" data-role="commands-verdict">{{ verdict.text }}</p>

    <p class="mt-3 text-[11px] leading-relaxed text-dim">
      Reprendre depuis le début efface la mémoire des commandes déjà appliquées et relit le flux du
      hub depuis sa première. Ce qui a expiré est ignoré ; le reste — prise de main à distance,
      bandeau — est ce que la salle devrait déjà montrer.
    </p>

    <template #actions>
      <span class="flex-1"></span>
      <Button
        size="small"
        data-action="commands.forget"
        :disabled="commands == null"
        @click="confirmOpen = true"
      >
        Reprendre les commandes depuis le début
      </Button>
    </template>
  </Dialog>

  <ConfirmDialog
    v-model:open="confirmOpen"
    title="Reprendre les commandes du hub ?"
    detail="La salle oublie les commandes qu'elle a déjà appliquées et relit celles du hub depuis la première. Celles qui ont expiré sont ignorées."
    cancel-label="Non"
    confirm-label="Reprendre"
    @confirm="forget()"
  />
</template>
