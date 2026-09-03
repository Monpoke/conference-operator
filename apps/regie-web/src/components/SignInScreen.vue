<script setup lang="ts">
import { Button, Field, Hint, Panel } from '@cloudnord/components'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from '../stores/session.js'

/**
 * La porte d'entrée de la régie mobile.
 *
 * Sa propre version plutôt que celle de la console, et c'est la disposition qui
 * les sépare : celle-ci s'ouvre sur un téléphone tenu d'une main, souvent au
 * fond d'une salle sombre. Ce qu'elles demandent au hub, en revanche, est
 * exactement la même chose — et vit dans `@cloudnord/hub-client`.
 *
 * Le formulaire reste **au-dessus** du bouton Google, comme sur la console.
 * Google exige internet au moment où l'on se connecte, et tout ce système est
 * bâti pour survivre à sa disparition : une régie qui ne s'ouvre que par Google
 * enferme l'équipe dehors le matin précis où le réseau tombe.
 */
const session = useSessionStore()
const { signingIn, error, google } = storeToRefs(session)

const email = ref('')
const password = ref('')

function submit(): void {
  void session.signIn(email.value, password.value)
}
</script>

<template>
  <main id="connexion" class="mx-auto w-full max-w-[420px] px-4 pt-[10vh]">
    <Panel title="Régie mobile">
      <form @submit.prevent="submit">
        <!--
          `autocomplete` et `inputmode` : sur un téléphone, ce sont eux qui
          décident si l'on tape une adresse d'une main au fond d'une salle
          sombre, ou si le trousseau la remplit.
        -->
        <Field
          id="email"
          v-model="email"
          label="Adresse"
          type="email"
          autocomplete="username"
          inputmode="email"
        />
        <Field
          id="motdepasse"
          v-model="password"
          label="Mot de passe"
          type="password"
          autocomplete="current-password"
        />
        <Button id="btn-connexion" type="submit" variant="primary" class="w-full" :disabled="signingIn">
          {{ signingIn ? 'Connexion…' : 'Se connecter' }}
        </Button>
      </form>

      <p v-if="error != null" id="connexion-erreur" class="mt-3 text-sm text-alert">{{ error }}</p>

      <template v-if="google != null">
        <Button id="btn-google" class="mt-3 w-full" @click="session.signInWithGoogle()">
          Continuer avec Google
        </Button>
        <Hint>Comptes @{{ google.domain }} uniquement.</Hint>
      </template>
    </Panel>
  </main>
</template>
