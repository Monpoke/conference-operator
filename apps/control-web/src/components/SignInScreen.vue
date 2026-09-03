<script setup lang="ts">
import { Button, Field, Hint, Panel } from '@cloudnord/components'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from '../stores/session.js'

/**
 * The mobile control app's front door.
 *
 * Its own version rather than the console's, and it is the layout that separates
 * them: this one opens on a phone held in one hand, often at the back of a dark
 * room. What they ask the hub, on the other hand, is exactly the same thing — and
 * lives in `@cloudnord/hub-client`.
 *
 * The form stays **above** the Google button, as on the console. Google requires
 * the internet at the moment one signs in, and this whole system is built to
 * survive its disappearance: a control app that only opens through Google locks
 * the team out on the very morning the network goes down.
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
          `autocomplete` and `inputmode`: on a phone they are what decides whether
          an address is typed one-handed at the back of a dark room, or filled in
          by the keychain.
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
