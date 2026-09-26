<script setup lang="ts">
import { Button, Field, Hint, Panel, useToast } from '@conference-operator/components'
import type { MontageJobView } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { MONTAGE_STATES, describe, useMontageStore } from '../stores/montage.js'

/**
 * The VODs' montage: what the workers are editing, and who they are.
 *
 * Read after the event rather than during it: a talk's video is edited once
 * its rushes are home, and the list says which are done, which wait for their
 * rushes, and which failed and why.
 */
const store = useMontageStore()
const { jobs, workers } = storeToRefs(store)
const toast = useToast()

/** Cuts waiting for somebody: nothing goes out for these talks until they are looked at. */
const toValidate = computed(() => jobs.value.filter((job) => job.state === 'a-valider').length)

const nom = ref('')
/** The token just created — shown once, here, and never again. */
const token = ref<string | null>(null)

function stateOf(job: MontageJobView): { label: string; tone: string } {
  return MONTAGE_STATES[job.state] ?? { label: job.state, tone: '' }
}

async function attempt(gesture: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await gesture()
    if (done !== '') toast.say(done)
  } catch {
    /* already reported by the client's error hook */
  }
}

async function create(): Promise<void> {
  const name = nom.value.trim()
  if (name === '') {
    toast.fail('Donnez un nom au worker : c’est ce qu’on lira dans la liste.')
    return
  }
  await attempt(async () => {
    token.value = await store.createWorker(name)
    nom.value = ''
  }, 'Worker créé')
}

async function copyToken(): Promise<void> {
  if (token.value == null) return
  await attempt(() => navigator.clipboard.writeText(token.value!), 'Jeton copié')
}
</script>

<template>
  <Panel title="Montages" class="col-span-full">
    <p v-if="toValidate > 0" id="montage-a-valider" class="mb-2 text-sm text-warn">
      {{ toValidate }} coupe{{ toValidate > 1 ? 's' : '' }} à valider — dans le dossier VOD du talk
      (Conférences → colonne VOD → « captation »).
    </p>
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr class="text-[11px] tracking-[.08em] text-dim uppercase">
            <th class="pr-2.5 pb-2 text-left font-semibold">Talk</th>
            <th class="pr-2.5 pb-2 text-left font-semibold">État</th>
            <th class="pr-2.5 pb-2 text-left font-semibold">Où il en est</th>
            <th class="pr-2.5 pb-2 text-left font-semibold">Worker</th>
            <th class="pb-2"></th>
          </tr>
        </thead>
        <tbody id="montage-rows">
          <tr v-if="jobs.length === 0">
            <td colspan="5" class="py-3.5 text-dim">
              Aucun montage : ils se mettent en file d’eux-mêmes quand une prise arrive dans le stockage.
            </td>
          </tr>
          <tr v-for="job in jobs" :key="job.id" :data-montage="job.id">
            <td class="border-t border-edge py-[9px] pr-2.5 align-middle">
              {{ job.title ?? job.sessionId }}
              <div v-if="job.erreur != null && job.state !== 'termine'" class="text-[11px]" :class="job.state === 'echoue' ? 'text-alert' : 'text-dim'">
                {{ job.erreur }}
              </div>
            </td>
            <td class="border-t border-edge py-[9px] pr-2.5 align-middle" :class="stateOf(job).tone">
              {{ stateOf(job).label }}
              <span v-if="job.tentatives > 1" class="text-dim"> · essai {{ job.tentatives }}</span>
            </td>
            <td
              class="border-t border-edge py-[9px] pr-2.5 align-middle tabular-nums"
              :class="job.marquesManquantes.length > 0 ? 'text-warn' : ''"
            >
              {{ describe(job) }}
            </td>
            <td class="border-t border-edge py-[9px] pr-2.5 align-middle text-dim">{{ job.worker ?? '' }}</td>
            <td class="border-t border-edge py-[9px] align-middle whitespace-nowrap">
              <Button v-if="job.state === 'termine'" size="small" @click="attempt(() => store.download(job.id), '')">
                Télécharger
              </Button>
              <Button
                v-if="job.state === 'attente' || job.state === 'en-cours'"
                size="small"
                variant="danger"
                @click="attempt(() => store.cancel(job.id), 'Montage annulé')"
              >
                Annuler
              </Button>
              <Button
                v-else
                size="small"
                class="ml-1"
                @click="attempt(() => store.relaunch(job.sessionId), 'Montage relancé')"
              >
                Relancer
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Hint>
      Un montage = intro, talk coupé sur les marques <strong>Début</strong> et <strong>Fin</strong>
      posées en régie, outro sponsors. Sans marque, la prise est gardée entière de ce côté — à
      reprendre à la main, ou à relancer après correction.
    </Hint>
  </Panel>

  <Panel title="Workers de montage">
    <ul id="montage-workers" class="mb-2 text-sm">
      <li v-if="workers.length === 0" class="text-dim">Aucun worker : rien ne sera monté.</li>
      <li
        v-for="worker in workers"
        :key="worker.id"
        class="flex items-center justify-between gap-2 border-t border-edge py-2 first:border-t-0"
      >
        <span :class="worker.revokedAt != null ? 'text-dim line-through' : ''">
          {{ worker.nom }}
          <span class="text-[11px] text-dim">
            · {{ worker.lastSeenAt == null ? 'jamais vu' : `vu ${new Date(worker.lastSeenAt).toLocaleString('fr-FR')}` }}
          </span>
        </span>
        <Button
          v-if="worker.revokedAt == null"
          size="small"
          variant="danger"
          @click="attempt(() => store.revokeWorker(worker.id), 'Worker révoqué')"
        >
          Révoquer
        </Button>
      </li>
    </ul>

    <Field id="montage-worker-nom" v-model="nom" label="Nouveau worker" placeholder="Mac mini du local technique" />
    <Button id="btn-montage-worker" size="small" @click="create">Créer le jeton</Button>

    <div v-if="token != null" class="mt-3 rounded-lg border border-warn p-3">
      <p class="mb-1.5 text-xs text-warn">
        Jeton affiché une seule fois : le hub n’en garde que l’empreinte.
      </p>
      <code class="block font-mono text-[11px] break-all">{{ token }}</code>
      <Button size="small" class="mt-2" @click="copyToken">Copier</Button>
    </div>

    <Hint>
      Un worker tourne où il y a du calcul — un poste, un serveur, la CI :
      <code>HUB_URL=… HUB_WORKER_TOKEN=wt_… pnpm --filter @conference-operator/vod-montage start</code>,
      ou l’image <code>vod-montage</code>. Il vient chercher le travail : aucun port à ouvrir.
    </Hint>
  </Panel>
</template>
