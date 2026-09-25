<script setup lang="ts">
import { viewPath } from '@conference-operator/contract'
import { Badge, Button, Empty, Hint, Panel, useToast } from '@conference-operator/components'
import { timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { ref, watch } from 'vue'
import ImageField from '../components/boucle/ImageField.vue'
import { FIELD, LABEL, orNull } from '../components/boucle/ui.js'
import { useBoucleStore } from '../stores/boucle.js'
import { useModerationStore, type HubPostDraft, type ScreenPost } from '../stores/moderation.js'

/**
 * Wall moderation, and the social wall as the rooms show it.
 *
 * Nothing the audience writes reaches a room screen without passing through
 * here, which is why the two buttons are far apart in weight rather than side
 * by side in the same one: publishing is the deliberate act, rejecting is the
 * reflex. walls.io's posts arrive already moderated there; here they can still
 * be hidden, or put forward.
 *
 * The `id`s below are kept from the string template on purpose. They are a
 * three-headed contract — the tests address them, the preview scripts click
 * them, and somebody debugging in a corridor during an event types them into a
 * console. Renaming them is a separate decision from migrating the view.
 */
const store = useModerationStore()
const images = useBoucleStore()
const { pending, screen, loading } = storeToRefs(store)
const toast = useToast()
const settingsPath = viewPath('reglages')

const SOURCES: Record<string, string> = {
  form: 'public',
  wallsio: 'walls.io',
  hub: 'console',
  bluesky: 'bluesky',
  mastodon: 'mastodon',
  x: 'x',
}

// The thumbnails of uploaded images need the hub's address for them.
watch(screen, (posts) => {
  const refs = posts.flatMap((post) => [post.image, post.avatar, post.sponsor?.logo ?? null])
  void images.loadPreviews(refs.filter((ref): ref is string => ref != null)).catch(() => {})
})

async function decide(id: string, decision: 'approve' | 'reject'): Promise<void> {
  try {
    await store.moderate(id, decision)
    toast.say(decision === 'approve' ? 'Message publié.' : 'Message rejeté.')
  } catch {
    // The hub client already raised the failure through `onError`; saying it
    // twice would stack two notices for one cause.
  }
}

async function hide(post: ScreenPost): Promise<void> {
  try {
    await store.moderate(post.id, 'reject')
    toast.say('Post retiré des écrans.')
  } catch {
    /* already reported */
  }
}

async function feature(post: ScreenPost, featured: boolean): Promise<void> {
  try {
    await store.feature(post.id, featured)
    toast.say(featured ? 'Post mis en avant.' : 'Post remis dans le fil.')
  } catch {
    /* already reported */
  }
}

// — Partner posts —
const empty = (): HubPostDraft => ({
  author: '',
  authorSubtitle: null,
  avatar: null,
  text: '',
  image: null,
  network: null,
  sponsor: null,
  featured: true,
})
const draft = ref<HubPostDraft>(empty())
const sponsorName = ref('')
const sponsorLogo = ref<string | null>(null)

function edit(post: ScreenPost): void {
  draft.value = {
    id: post.id,
    author: post.author,
    authorSubtitle: post.authorSubtitle,
    avatar: post.avatar,
    text: post.text,
    image: post.image,
    network: post.network,
    sponsor: post.sponsor,
    featured: post.featured,
  }
  sponsorName.value = post.sponsor?.name ?? ''
  sponsorLogo.value = post.sponsor?.logo ?? null
}

function cancel(): void {
  draft.value = empty()
  sponsorName.value = ''
  sponsorLogo.value = null
}

async function savePost(): Promise<void> {
  if (draft.value.author.trim() === '') {
    toast.fail('Le post doit avoir un auteur')
    return
  }
  if (draft.value.text.trim() === '' && draft.value.image == null) {
    toast.fail('Le post doit avoir un texte ou une image')
    return
  }
  const name = sponsorName.value.trim()
  try {
    await store.savePost({
      ...draft.value,
      author: draft.value.author.trim(),
      authorSubtitle: orNull(draft.value.authorSubtitle),
      network: orNull(draft.value.network),
      sponsor: name === '' ? null : { name, logo: sponsorLogo.value },
    })
    toast.say(draft.value.id == null ? 'Post publié sur le mur.' : 'Post modifié.')
    cancel()
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <div
    id="moderation-view"
    class="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-3.5"
  >
    <Panel class="col-span-full" title="Modération du mur">
      <Hint class="mt-0 mb-3.5">
        Rien de ce que le public écrit n'atteint un écran de salle sans passer par ici : ces
        messages sont projetés devant le public.
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

    <Panel class="col-span-full" title="Mur social — sur les écrans">
      <Hint class="mt-0 mb-3.5">
        La mosaïque de la boucle : walls.io, les messages publiés du public, les posts
        partenaires. Un post mis en avant, épinglé sur walls.io ou partenaire ouvre chaque page.
        walls.io modère ses posts lui-même ; les masquer ici les retire des écrans, quoi que
        walls.io dise ensuite. Le jeton walls.io se règle dans
        <a :href="settingsPath" class="text-brand underline">Réglages</a>.
      </Hint>

      <div id="social-wall">
        <Empty v-if="screen.length === 0 && !loading">
          Aucun post sur le mur : la boucle saute la scène.
        </Empty>

        <article
          v-for="post in screen"
          :key="post.id"
          class="mb-2.5 flex gap-3 rounded-[9px] border border-edge p-3"
          :class="post.featured ? 'border-brand' : ''"
          :data-post="post.id"
        >
          <img
            v-if="images.previewOf(post.image)"
            :src="images.previewOf(post.image)!"
            alt=""
            class="h-20 w-20 flex-none rounded-md object-cover"
          />
          <div class="min-w-0 flex-1">
            <div class="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-dim">
              <Badge class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">{{ SOURCES[post.source] ?? post.source }}</Badge>
              <Badge v-if="post.sponsor" class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">
                partenaire · {{ post.sponsor.name }}
              </Badge>
              <Badge v-else-if="post.pinned" class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">épinglé sur walls.io</Badge>
              <Badge v-else-if="post.featured" class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">en avant</Badge>
              <span>{{ post.author }}</span>
              <span v-if="post.network">{{ post.network }}</span>
              <span>{{ timeAgo(post.createdAt) }}</span>
            </div>
            <p class="mb-2.5 line-clamp-3 text-sm leading-snug break-words">{{ post.text }}</p>
            <div class="flex flex-wrap gap-2">
              <Button
                v-if="!post.featured"
                size="small"
                data-role="feature"
                @click="feature(post, true)"
              >
                Mettre en avant
              </Button>
              <Button
                v-else-if="!post.pinned && post.sponsor == null"
                size="small"
                data-role="unfeature"
                @click="feature(post, false)"
              >
                Remettre dans le fil
              </Button>
              <Button v-if="post.source === 'hub'" size="small" data-role="edit" @click="edit(post)">
                Modifier
              </Button>
              <Button variant="danger" size="small" data-role="hide" @click="hide(post)">
                Masquer
              </Button>
            </div>
          </div>
        </article>
      </div>
    </Panel>

    <Panel class="col-span-full" :title="draft.id == null ? 'Écrire un post partenaire' : 'Modifier le post'">
      <Hint class="mt-0 mb-3.5">
        Publié directement, en tête de page. Avec un partenaire, la carte porte le badge
        « Partenaire » et son logo ; sans, c'est un post de l'événement.
      </Hint>
      <div id="hub-post" class="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-x-3">
        <div>
          <label :class="LABEL" for="hub-post-author">Auteur</label>
          <input id="hub-post-author" v-model="draft.author" maxlength="80" :class="FIELD" />
          <label :class="LABEL" for="hub-post-subtitle">Sous le nom (poste, entreprise)</label>
          <input
            id="hub-post-subtitle"
            :value="draft.authorSubtitle ?? ''"
            maxlength="120"
            :class="FIELD"
            @input="draft.authorSubtitle = ($event.target as HTMLInputElement).value"
          />
          <ImageField id="hub-post-avatar" v-model="draft.avatar" label="Photo de l'auteur" placeholder="Initiales" />
          <label :class="LABEL" for="hub-post-text">Texte</label>
          <textarea id="hub-post-text" v-model="draft.text" rows="5" maxlength="1500" :class="FIELD" />
        </div>
        <div>
          <ImageField id="hub-post-image" v-model="draft.image" label="Image" placeholder="Aucune image" />
          <label :class="LABEL" for="hub-post-network">Réseau (pied de carte)</label>
          <input
            id="hub-post-network"
            :value="draft.network ?? ''"
            maxlength="30"
            placeholder="LinkedIn, Instagram…"
            :class="FIELD"
            @input="draft.network = ($event.target as HTMLInputElement).value"
          />
          <label :class="LABEL" for="hub-post-sponsor">Partenaire</label>
          <input
            id="hub-post-sponsor"
            v-model="sponsorName"
            maxlength="80"
            placeholder="Vide : un post de l'événement"
            :class="FIELD"
          />
          <ImageField id="hub-post-sponsor-logo" v-model="sponsorLogo" label="Logo du partenaire" placeholder="Aucun logo" />
          <label class="mb-3 flex items-center gap-2 text-sm">
            <input id="hub-post-featured" v-model="draft.featured" type="checkbox" class="w-auto" />
            Mettre en avant (toujours en tête de page — d'office pour un partenaire)
          </label>
        </div>
      </div>
      <div class="flex gap-2">
        <Button id="btn-hub-post" variant="primary" size="small" @click="savePost">
          {{ draft.id == null ? 'Publier sur le mur' : 'Enregistrer' }}
        </Button>
        <Button v-if="draft.id != null" size="small" @click="cancel">Annuler</Button>
      </div>
    </Panel>
  </div>
</template>
