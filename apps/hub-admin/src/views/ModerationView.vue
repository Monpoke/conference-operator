<script setup lang="ts">
import { viewPath } from '@conference-operator/contract'
import { Badge, Button, Empty, Hint, Panel, useToast } from '@conference-operator/components'
import { timeAgo } from '@conference-operator/format'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ImageField from '../components/boucle/ImageField.vue'
import { FIELD, LABEL, orNull } from '../components/boucle/ui.js'
import { useBoucleStore } from '../stores/boucle.js'
import {
  PAGE_SIZE,
  useModerationStore,
  type HubPostDraft,
  type WallPost,
  type WallView,
} from '../stores/moderation.js'

/**
 * Wall moderation, and the social wall as the rooms show it.
 *
 * Nothing the audience writes reaches a room screen without passing through
 * here, which is why the two buttons are far apart in weight rather than side
 * by side in the same one: publishing is the deliberate act, rejecting is the
 * reflex. walls.io's posts arrive already moderated there; here they can still
 * be hidden, or put forward.
 *
 * Read on a phone first — moderating happens from the back of a room, standing:
 * one column of cards, the actions under the text, the writing form folded away
 * behind a button at the top rather than at the foot of a long list.
 *
 * The `id`s below are kept from the string template on purpose. They are a
 * three-headed contract — the tests address them, the preview scripts click
 * them, and somebody debugging in a corridor during an event types them into a
 * console. Renaming them is a separate decision from migrating the view.
 */
const store = useModerationStore()
const images = useBoucleStore()
const { view, items, total, counts, page, loading, sponsors } = storeToRefs(store)
const toast = useToast()
const settingsPath = viewPath('reglages')
const bouclePath = viewPath('boucle')

const SOURCES: Record<string, string> = {
  form: 'public',
  wallsio: 'walls.io',
  hub: 'console',
  bluesky: 'bluesky',
  mastodon: 'mastodon',
  x: 'x',
}

const VIEWS: { id: WallView; label: string }[] = [
  { id: 'pending', label: 'À relire' },
  { id: 'approved', label: 'Publiés' },
  { id: 'rejected', label: 'Rejetés' },
]

const EMPTY: Record<WallView, string> = {
  pending: 'Rien à relire.',
  approved: 'Aucun post sur le mur : la boucle saute la scène.',
  rejected: 'Aucun post rejeté ni masqué.',
}

const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

onMounted(() => {
  // Without the program's partners the form still writes a post of the event;
  // the failure is already reported by the hub client.
  void store.loadSponsors().catch(() => {})
})

// The thumbnails of uploaded images need the hub's address for them.
watch(items, (posts) => {
  const refs = posts.flatMap((post) => [post.image, post.avatar, post.sponsor?.logo ?? null])
  void images.loadPreviews(refs.filter((ref): ref is string => ref != null)).catch(() => {})
})

// — Search: sent once typing pauses, not on every key —
const search = ref(store.query)
let typing: ReturnType<typeof setTimeout> | null = null
watch(search, (q) => {
  if (typing != null) clearTimeout(typing)
  typing = setTimeout(() => void store.search(q.trim()).catch(() => {}), 300)
})
onBeforeUnmount(() => {
  if (typing != null) clearTimeout(typing)
})

async function showView(next: WallView): Promise<void> {
  try {
    await store.show(next)
  } catch {
    /* already reported */
  }
}

async function goTo(next: number): Promise<void> {
  try {
    await store.goTo(next)
    document.getElementById('wall-toolbar')?.scrollIntoView?.({ block: 'start' })
  } catch {
    /* already reported */
  }
}

async function decide(id: string, decision: 'approve' | 'reject'): Promise<void> {
  try {
    await store.moderate(id, decision)
    toast.say(decision === 'approve' ? 'Message publié.' : 'Message rejeté.')
  } catch {
    // The hub client already raised the failure through `onError`; saying it
    // twice would stack two notices for one cause.
  }
}

async function hide(post: WallPost): Promise<void> {
  try {
    await store.moderate(post.id, 'reject')
    toast.say('Post retiré des écrans.')
  } catch {
    /* already reported */
  }
}

async function feature(post: WallPost, featured: boolean): Promise<void> {
  try {
    await store.feature(post.id, featured)
    toast.say(featured ? 'Post mis en avant.' : 'Post remis dans le fil.')
  } catch {
    /* already reported */
  }
}

function shown(post: WallPost): string {
  if (post.impressions === 0) return 'jamais affiché'
  const times = `${post.impressions.toLocaleString('fr-FR')} affichage${post.impressions > 1 ? 's' : ''}`
  return post.lastShownAt == null ? times : `${times} · dernier ${timeAgo(post.lastShownAt)}`
}

// — Writing a post: folded away until asked for —
const composing = ref(false)
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
/** The partner chosen: a program key, `''` for none, or a name kept from before posts were attached. */
const sponsorKey = ref('')
const sponsorLogo = ref<string | null>(null)
/** A post attached by name only, before partners came from the program: kept as it is. */
const legacySponsor = ref<string | null>(null)
const LEGACY = '__nom__'

const chosenSponsor = computed(() => sponsors.value.find((sponsor) => sponsor.key === sponsorKey.value) ?? null)

async function openComposer(): Promise<void> {
  composing.value = true
  await nextTick()
  document.getElementById('hub-post')?.scrollIntoView?.({ block: 'start' })
  document.getElementById('hub-post-author')?.focus()
}

function chooseSponsor(key: string): void {
  sponsorKey.value = key
  // The author of a partner's post is, most of the time, the partner.
  const partner = sponsors.value.find((sponsor) => sponsor.key === key)
  if (partner != null && draft.value.author.trim() === '') draft.value.author = partner.name
}

function edit(post: WallPost): void {
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
  legacySponsor.value = post.sponsor != null && post.sponsor.key == null ? post.sponsor.name : null
  sponsorKey.value = post.sponsor == null ? '' : (post.sponsor.key ?? LEGACY)
  sponsorLogo.value = post.sponsor?.logo ?? null
  void openComposer()
}

function cancel(): void {
  draft.value = empty()
  sponsorKey.value = ''
  sponsorLogo.value = null
  legacySponsor.value = null
  composing.value = false
}

function sponsorOf(): HubPostDraft['sponsor'] {
  if (sponsorKey.value === '') return null
  if (sponsorKey.value === LEGACY) {
    return legacySponsor.value == null ? null : { key: null, name: legacySponsor.value, logo: sponsorLogo.value }
  }
  const partner = chosenSponsor.value
  // The hub takes the name and the logo from the program; these are what it
  // keeps should the program lose the partner.
  return { key: sponsorKey.value, name: partner?.name ?? sponsorKey.value, logo: sponsorLogo.value }
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
  const editing = draft.value.id != null
  try {
    await store.savePost({
      ...draft.value,
      author: draft.value.author.trim(),
      authorSubtitle: orNull(draft.value.authorSubtitle),
      network: orNull(draft.value.network),
      sponsor: sponsorOf(),
    })
    toast.say(editing ? 'Post modifié.' : 'Post publié sur le mur.')
    cancel()
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <div id="moderation-view" class="flex min-w-0 flex-col gap-3.5">
    <Panel>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-[11px] font-semibold tracking-[.14em] text-dim uppercase">Mur social</h2>
        <Button
          v-if="!composing"
          id="btn-compose"
          variant="primary"
          size="small"
          @click="openComposer"
        >
          Écrire un post
        </Button>
      </div>
      <Hint class="mt-2 mb-0">
        Rien de ce que le public écrit n'atteint un écran de salle sans passer par ici. walls.io
        modère ses posts lui-même ; les masquer ici les retire des écrans, quoi que walls.io dise
        ensuite. Le jeton walls.io se règle dans
        <a :href="settingsPath" class="text-brand underline">Réglages</a>, la fréquence des posts
        sponsorisés dans <a :href="bouclePath" class="text-brand underline">Boucle</a>.
      </Hint>

      <section v-if="composing" id="hub-post" class="mt-3.5 border-t border-edge pt-3.5">
        <h3 class="mb-2.5 text-sm font-semibold">
          {{ draft.id == null ? 'Écrire un post' : 'Modifier le post' }}
        </h3>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-x-3">
          <div class="min-w-0">
            <label :class="LABEL" for="hub-post-sponsor">Partenaire</label>
            <select
              id="hub-post-sponsor"
              :value="sponsorKey"
              :class="FIELD"
              @change="chooseSponsor(($event.target as HTMLSelectElement).value)"
            >
              <option value="">Aucun : un post de l'événement</option>
              <option v-for="sponsor in sponsors" :key="sponsor.key" :value="sponsor.key">
                {{ sponsor.name }}{{ sponsor.tiers.length > 0 ? ` (${sponsor.tiers.join(', ')})` : '' }}
              </option>
              <option v-if="legacySponsor != null" :value="LEGACY">{{ legacySponsor }} (hors programme)</option>
            </select>
            <p v-if="sponsors.length === 0" class="-mt-1.5 mb-2.5 text-xs text-dim">
              Aucun partenaire dans le programme importé.
            </p>
            <div v-if="sponsorKey !== ''" class="mb-2.5 flex items-center gap-2 text-xs text-dim">
              <img
                v-if="sponsorLogo == null && chosenSponsor?.logoPreview"
                :src="chosenSponsor.logoPreview"
                alt=""
                class="h-8 w-8 rounded-full border border-edge bg-white object-contain"
              />
              <span>Post sponsorisé : badge « Partenaire » et logo sur la carte.</span>
            </div>
            <ImageField
              v-if="sponsorKey !== ''"
              id="hub-post-sponsor-logo"
              v-model="sponsorLogo"
              label="Logo du partenaire"
              placeholder="Celui du programme"
            />
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
            <label :class="LABEL" for="hub-post-text">Texte</label>
            <textarea id="hub-post-text" v-model="draft.text" rows="5" maxlength="1500" :class="FIELD" />
          </div>
          <div class="min-w-0">
            <ImageField id="hub-post-image" v-model="draft.image" label="Image" placeholder="Aucune image" />
            <ImageField id="hub-post-avatar" v-model="draft.avatar" label="Photo de l'auteur" placeholder="Initiales" />
            <label :class="LABEL" for="hub-post-network">Réseau (pied de carte)</label>
            <input
              id="hub-post-network"
              :value="draft.network ?? ''"
              maxlength="30"
              placeholder="LinkedIn, Instagram…"
              :class="FIELD"
              @input="draft.network = ($event.target as HTMLInputElement).value"
            />
            <label class="mb-3 flex items-start gap-2 text-sm">
              <input id="hub-post-featured" v-model="draft.featured" type="checkbox" class="mt-1 w-auto" />
              <span>
                Mettre en avant (en tête de page — d'office pour un partenaire, sauf si la boucle glisse
                les posts sponsorisés dans le fil)
              </span>
            </label>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button id="btn-hub-post" variant="primary" size="small" @click="savePost">
            {{ draft.id == null ? 'Publier sur le mur' : 'Enregistrer' }}
          </Button>
          <Button id="btn-hub-post-cancel" size="small" @click="cancel">Annuler</Button>
        </div>
      </section>
    </Panel>

    <Panel>
      <div id="wall-toolbar" class="flex scroll-mt-4 flex-col gap-2.5 md:flex-row md:items-center md:justify-between">
        <div class="flex gap-1" role="tablist" aria-label="Posts du mur">
          <Button
            v-for="tab in VIEWS"
            :id="`wall-tab-${tab.id}`"
            :key="tab.id"
            variant="tab"
            size="small"
            role="tab"
            :aria-selected="view === tab.id"
            :active="view === tab.id"
            class="flex-1 md:flex-none"
            @click="showView(tab.id)"
          >
            {{ tab.label }}
            <span class="ml-1 text-xs text-dim" :data-count="tab.id">{{ counts[tab.id] }}</span>
          </Button>
        </div>
        <input
          id="wall-search"
          v-model="search"
          type="search"
          maxlength="100"
          placeholder="Rechercher : texte, auteur, partenaire…"
          aria-label="Rechercher dans les posts"
          :class="[FIELD, 'mb-0 md:max-w-[320px]']"
        />
      </div>

      <div id="wall-posts" class="mt-3.5" :data-view="view">
        <Empty v-if="items.length === 0 && !loading">
          {{ search.trim() === '' ? EMPTY[view] : 'Aucun post ne correspond à la recherche.' }}
        </Empty>

        <article
          v-for="post in items"
          :key="post.id"
          class="mb-2.5 flex gap-3 rounded-[9px] border border-edge p-3"
          :class="post.status === 'approved' && post.featured ? 'border-brand' : ''"
          :data-post="post.id"
          :data-message="post.status === 'pending' ? post.id : undefined"
        >
          <img
            v-if="images.previewOf(post.image)"
            :src="images.previewOf(post.image)!"
            alt=""
            class="h-16 w-16 flex-none rounded-md object-cover md:h-20 md:w-20"
          />
          <div class="min-w-0 flex-1">
            <div class="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
              <Badge class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">{{ SOURCES[post.source] ?? post.source }}</Badge>
              <Badge v-if="post.sponsor" class="px-1.5 py-0.5 text-[10px] tracking-[.08em]" data-role="sponsor">
                partenaire · {{ post.sponsor.name }}
              </Badge>
              <Badge v-else-if="post.pinned" class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">épinglé sur walls.io</Badge>
              <Badge v-else-if="post.featured && post.status === 'approved'" class="px-1.5 py-0.5 text-[10px] tracking-[.08em]">en avant</Badge>
              <Badge
                v-if="post.status === 'approved' && !post.onScreen"
                class="px-1.5 py-0.5 text-[10px] tracking-[.08em]"
                title="Trop ancien pour la mosaïque, ou retiré par walls.io"
              >
                hors écran
              </Badge>
              <span class="font-medium text-text">{{ post.author }}</span>
              <span v-if="post.network">{{ post.network }}</span>
              <span>{{ timeAgo(post.createdAt) }}</span>
            </div>
            <p class="mb-2 line-clamp-4 text-sm leading-snug break-words">{{ post.text }}</p>
            <p v-if="post.status !== 'pending'" class="mb-2 text-xs text-dim" data-role="impressions">
              {{ shown(post) }}
            </p>

            <div v-if="post.status === 'pending'" class="flex flex-wrap gap-2">
              <Button variant="primary" size="small" data-role="approve" @click="decide(post.id, 'approve')">
                Publier
              </Button>
              <Button variant="danger" size="small" data-role="reject" @click="decide(post.id, 'reject')">
                Rejeter
              </Button>
            </div>
            <div v-else-if="post.status === 'approved'" class="flex flex-wrap gap-2">
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
            <div v-else class="flex flex-wrap gap-2">
              <Button size="small" data-role="restore" @click="decide(post.id, 'approve')">
                Republier
              </Button>
            </div>
          </div>
        </article>
      </div>

      <nav
        v-if="pages > 1"
        id="wall-pages"
        class="mt-1 flex items-center justify-between gap-2"
        aria-label="Pages"
      >
        <Button size="small" data-role="previous" :disabled="page <= 1" @click="goTo(page - 1)">
          Précédent
        </Button>
        <span class="text-center text-xs text-dim">Page {{ page }} sur {{ pages }} · {{ total }} posts</span>
        <Button size="small" data-role="next" :disabled="page >= pages" @click="goTo(page + 1)">
          Suivant
        </Button>
      </nav>
    </Panel>
  </div>
</template>
