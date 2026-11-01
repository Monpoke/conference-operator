<script setup lang="ts">
import { Button, Field, Hint, Panel, useToast } from '@conference-operator/components'
import { DEPLOYMENT_WORKER_ID } from '@conference-operator/contract'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useMontageStore } from '../stores/montage.js'

/** Who edits the videos: a setting, looked at once, away from the videos themselves. */
const store = useMontageStore()
const { workers } = storeToRefs(store)
const toast = useToast()

const nom = ref('')
/** The token just created — shown once, here, and never again. */
const token = ref<string | null>(null)

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
        <!-- Its token is in the hub's configuration: a revocation here would last
             until the next start. It is retired by removing MONTAGE_WORKER_TOKEN. -->
        <span v-if="worker.id === DEPLOYMENT_WORKER_ID" class="text-[11px] text-dim">géré par le déploiement</span>
        <Button
          v-else-if="worker.revokedAt == null"
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
