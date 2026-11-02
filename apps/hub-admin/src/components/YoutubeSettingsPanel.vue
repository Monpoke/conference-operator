<script setup lang="ts">
import { Button, Hint, Panel, useToast } from '@conference-operator/components'
import { storeToRefs } from 'pinia'
import { onMounted, ref } from 'vue'
import { useYoutubeStore } from '../stores/youtube.js'

/** The link to the YouTube channel: the Google project's identifiers, then the channel's consent. */
const store = useYoutubeStore()
const { status } = storeToRefs(store)
const toast = useToast()
const clientId = ref('')
const clientSecret = ref('')

onMounted(async () => {
  await store.load().catch(() => undefined)
  clientId.value = status.value?.clientId ?? ''
  const issue = new URLSearchParams(window.location.search).get('youtube')
  if (issue === 'ok') toast.say('Chaîne YouTube connectée')
  if (issue === 'erreur') toast.say('La connexion à YouTube a échoué : recommencez')
})

async function save(): Promise<void> {
  try {
    await store.setClient(clientId.value, clientSecret.value)
    clientSecret.value = ''
    toast.say('Identifiants Google enregistrés')
  } catch {
    /* already reported by the hub client */
  }
}

const FIELD = 'w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text'
</script>

<template>
  <Panel id="youtube-reglages" title="Chaîne YouTube">
    <p class="mb-2 text-[13px] text-dim">
      Pour envoyer les vidéos montées sur une chaîne. Dans un projet Google Cloud, activez l'API YouTube Data v3
      et créez un identifiant OAuth de type « Application Web », avec cette adresse de redirection :
    </p>
    <code v-if="status" id="youtube-redirection" class="mb-3 block text-xs break-all">{{ status.redirectUri }}</code>
    <label class="mb-1 block text-xs text-dim" for="youtube-client-id">ID client</label>
    <input id="youtube-client-id" v-model="clientId" autocomplete="off" spellcheck="false" :class="FIELD" class="mb-2 font-mono">
    <label class="mb-1 block text-xs text-dim" for="youtube-client-secret">Code secret du client</label>
    <input id="youtube-client-secret" v-model="clientSecret" type="password" autocomplete="off" :placeholder="status?.hasSecret ? 'Enregistré : à ressaisir pour le changer' : ''" :class="FIELD" class="mb-2">
    <div class="flex flex-wrap items-center gap-2">
      <Button id="btn-youtube-enregistrer" size="small" :disabled="clientId.trim() === '' || clientSecret.trim() === ''" @click="save">Enregistrer</Button>
      <Button v-if="status?.connected !== true" id="btn-youtube-connecter" size="small" variant="primary" :disabled="status?.hasSecret !== true" @click="store.connect().catch(() => undefined)">Connecter la chaîne</Button>
      <Button v-else id="btn-youtube-deconnecter" size="small" @click="store.disconnect().catch(() => undefined)">Déconnecter</Button>
      <span v-if="status?.connected" id="youtube-chaine" class="text-sm text-ok">Connectée{{ status.channel == null ? '' : ` : ${status.channel}` }}</span>
    </div>
    <Hint class="mb-0">Les vidéos sont toujours envoyées en privé : la publication se fait ensuite dans YouTube Studio.</Hint>
  </Panel>
</template>
