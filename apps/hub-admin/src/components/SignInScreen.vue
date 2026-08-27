<script setup lang="ts">
import { Button, Field, Hint, Panel } from '@cloudnord/components'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from '../stores/session.js'

/**
 * The way in.
 *
 * The password form stays above the Google button, always. Google needs the
 * internet at the moment somebody signs in, and this whole system is built to
 * survive that being gone — a console that only opens through Google locks the
 * team out on exactly the morning the network drops.
 */
const session = useSessionStore()
const { signingIn, error, google } = storeToRefs(session)

const email = ref('')
const password = ref('')

function submit(): void {
  void session.signIn(email.value, password.value)
}

/**
 * Le store porte l'appel : il faut un POST, puis une navigation.
 *
 * Better Auth ne redirige pas depuis un GET sur cette adresse — il répond
 * `null`. C'est la réponse à laquelle mène un `location.assign` naïf, et elle
 * ne dit rien de ce qui a manqué.
 */
function signInWithGoogle(): void {
  void session.signInWithGoogle()
}
</script>

<template>
  <main id="connexion" class="mx-auto max-w-[420px] px-4 pt-[12vh]">
    <Panel title="Console d'exploitation">
      <form @submit.prevent="submit">
        <Field id="email" v-model="email" label="Adresse" type="email" />
        <Field id="motdepasse" v-model="password" label="Mot de passe" type="password" />
        <Button id="btn-connexion" type="submit" variant="primary" class="w-full" :disabled="signingIn">
          {{ signingIn ? 'Connexion…' : 'Se connecter' }}
        </Button>
      </form>

      <p v-if="error != null" id="connexion-erreur" class="mt-3 text-sm text-alerte">{{ error }}</p>

      <!--
        Rendered only when the hub knows what to do with it: offering a sign-in
        that fails on click is worth less than offering nothing.
      -->
      <template v-if="google != null">
        <Button
          id="btn-google"
          class="mt-3 w-full"
          @click="signInWithGoogle"
        >
          Continuer avec Google
        </Button>
        <Hint>Comptes @{{ google.domain }} uniquement.</Hint>
      </template>
    </Panel>
  </main>
</template>
