<script setup lang="ts">
import { ACCESS_ROLE_NAMES, ROLE_LABELS, parseRoles, type AccessRole } from '@conference-operator/contract'
import { Badge, Button, Empty, Field, Hint, Panel, useToast } from '@conference-operator/components'
import { createHubAdmin, type AdminResult, type HubUser } from '@conference-operator/hub-client'
import { onMounted, ref } from 'vue'
import { useSessionStore } from '../stores/session.js'

/**
 * Who opens the console, and with which groups.
 *
 * Groups add up: an account holding Modération and Régie mobile can do both.
 * The table itself lives in the code (`ACCESS_ROLES`); this view only assigns
 * it. A new Google account arrives in Lecture seule and waits here.
 */
const session = useSessionStore()
const toast = useToast()
const admin = createHubAdmin({ token: session.client.token })

const users = ref<HubUser[]>([])
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    report(await admin.listUsers(), (list) => {
      users.value = list
    })
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

function report<T>(result: AdminResult<T>, then: (value: T) => void): boolean {
  if (!result.ok) {
    toast.fail(result.message)
    return false
  }
  then(result.value)
  return true
}

function isSelf(user: HubUser): boolean {
  return user.email === session.identity
}

async function toggle(user: HubUser, role: AccessRole): Promise<void> {
  const current = parseRoles(user.role)
  const next = current.includes(role) ? current.filter((held) => held !== role) : [...current, role]
  // An admin removing their own admin group would lock themselves out of this page.
  if (isSelf(user) && role === 'admin' && !next.includes('admin')) {
    toast.fail('Vous ne pouvez pas retirer votre propre accès admin.')
    return
  }
  if (next.length === 0) {
    toast.fail('Un compte garde au moins un groupe : désactivez-le plutôt.')
    return
  }
  if (report(await admin.setRoles(user.id, next), () => {})) {
    user.role = next.join(',')
    toast.say(`Groupes de ${user.email} mis à jour`)
  }
}

async function toggleBan(user: HubUser): Promise<void> {
  if (isSelf(user)) return
  const result = user.banned === true ? await admin.unban(user.id) : await admin.ban(user.id)
  if (report(result, () => {})) {
    user.banned = user.banned !== true
    toast.say(user.banned ? `${user.email} désactivé` : `${user.email} réactivé`)
  }
}

async function resetPassword(user: HubUser): Promise<void> {
  const password = globalThis.prompt(`Nouveau mot de passe pour ${user.email} (8 caractères minimum)`)
  if (password == null) return
  if (password.length < 8) {
    toast.fail('Le mot de passe doit faire au moins 8 caractères.')
    return
  }
  if (report(await admin.setPassword(user.id, password), () => {})) {
    toast.say(`Mot de passe de ${user.email} remplacé`)
  }
}

const email = ref('')
const name = ref('')
const password = ref('')
const newRoles = ref<AccessRole[]>(['readonly'])

function toggleNew(role: AccessRole): void {
  newRoles.value = newRoles.value.includes(role)
    ? newRoles.value.filter((held) => held !== role)
    : [...newRoles.value, role]
}

async function create(): Promise<void> {
  if (email.value.trim() === '' || name.value.trim() === '' || password.value.length < 8) {
    toast.fail('Adresse, nom et mot de passe (8 caractères minimum) sont requis.')
    return
  }
  if (newRoles.value.length === 0) {
    toast.fail('Choisissez au moins un groupe.')
    return
  }
  const result = await admin.createUser({
    email: email.value.trim(),
    name: name.value.trim(),
    password: password.value,
    roles: newRoles.value,
  })
  if (report(result, () => {})) {
    toast.say(`Compte ${email.value.trim()} créé`)
    email.value = ''
    name.value = ''
    password.value = ''
    newRoles.value = ['readonly']
    await load()
  }
}
</script>

<template>
  <div id="access-view" class="grid items-start gap-3.5 lg:grid-cols-[1fr_320px]">
    <Panel title="Comptes">
      <Empty v-if="!loading && users.length === 0">Aucun compte.</Empty>
      <article
        v-for="user in users"
        :id="`user-${user.id}`"
        :key="user.id"
        class="mb-2.5 rounded-[9px] border border-edge p-3"
        :class="user.banned === true ? 'opacity-60' : ''"
      >
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <strong class="text-sm">{{ user.name }}</strong>
          <span class="text-xs text-dim">{{ user.email }}</span>
          <Badge v-if="isSelf(user)" class="px-1.5 py-0.5 text-[10px]">vous</Badge>
          <Badge v-if="user.banned === true" variant="warning" class="px-1.5 py-0.5 text-[10px]">
            désactivé
          </Badge>
          <div class="ml-auto flex gap-1.5">
            <Button size="small" @click="resetPassword(user)">Mot de passe</Button>
            <Button v-if="!isSelf(user)" size="small" @click="toggleBan(user)">
              {{ user.banned === true ? 'Réactiver' : 'Désactiver' }}
            </Button>
          </div>
        </div>
        <div class="flex flex-wrap gap-x-4 gap-y-1.5">
          <label
            v-for="role in ACCESS_ROLE_NAMES"
            :key="role"
            class="flex items-center gap-1.5 text-[13px]"
          >
            <input
              type="checkbox"
              :checked="parseRoles(user.role).includes(role)"
              @change="toggle(user, role)"
            />
            {{ ROLE_LABELS[role] }}
          </label>
        </div>
      </article>
    </Panel>

    <Panel title="Nouveau compte">
      <Field id="new-user-email" v-model="email" label="Adresse" inputmode="email" autocomplete="off" />
      <Field id="new-user-name" v-model="name" label="Nom" autocomplete="off" />
      <Field
        id="new-user-password"
        v-model="password"
        label="Mot de passe provisoire"
        type="password"
        autocomplete="new-password"
      />
      <div class="mb-[11px] flex flex-col gap-1.5">
        <label v-for="role in ACCESS_ROLE_NAMES" :key="role" class="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" :checked="newRoles.includes(role)" @change="toggleNew(role)" />
          {{ ROLE_LABELS[role] }}
        </label>
      </div>
      <Button id="btn-create-user" variant="primary" class="w-full" @click="create">Créer</Button>
      <Hint>
        Les comptes Google du domaine arrivent seuls, en Lecture seule. Un changement de groupe
        s'applique au hub tout de suite, et à la console de la personne à son prochain rechargement.
      </Hint>
    </Panel>
  </div>
</template>
