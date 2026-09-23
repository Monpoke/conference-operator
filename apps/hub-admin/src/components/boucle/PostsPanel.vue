<script setup lang="ts">
import type { Post } from '@conference-operator/contract'
import { Button, Empty, Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import ImageField from './ImageField.vue'
import ListControls from './ListControls.vue'
import SaveBar from './SaveBar.vue'
import { BOX, FIELD, LABEL, SMALL } from './ui.js'

/**
 * The hand-fed social wall: walls.io's offline fallback.
 *
 * Posts copied from LinkedIn by an organiser, shown when the room cannot reach
 * walls.io — or when this edition has none.
 */
const store = useBoucleStore()
const toast = useToast()
const MAX_POSTS = 40

const { draft, dirty, reset } = useDraft(() => (store.boucle == null ? null : store.boucle.mur))

function add(): void {
  draft.value?.posts.push({
    auteur: '',
    titre: '',
    photo: null,
    date: '',
    texte: '',
    image: null,
    reactions: null,
    commentaires: null,
    reseau: 'LinkedIn',
  })
}

/** Empty is "not shown", and the contract says it with `null`, not 0. */
function count(event: Event): number | null {
  const value = (event.target as HTMLInputElement).value.trim()
  return value === '' ? null : Math.max(0, Math.round(Number(value)) || 0)
}

function setCount(post: Post, field: 'reactions' | 'commentaires', event: Event): void {
  post[field] = count(event)
}

async function save(): Promise<void> {
  if (draft.value == null) return
  if (draft.value.posts.some((post) => post.auteur.trim() === '')) {
    toast.fail('Chaque post doit avoir un auteur')
    return
  }
  try {
    await store.save('mur', draft.value)
    reset()
    toast.say('Mur de posts enregistré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Mur de posts (manuel)" class="col-span-full">
    <div v-if="draft != null" id="boucle-mur" class="flex flex-1 flex-col">
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-x-2">
        <div>
          <label :class="LABEL" for="boucle-mur-titre">Titre</label>
          <input id="boucle-mur-titre" v-model="draft.titre" maxlength="60" :class="FIELD" />
        </div>
        <div>
          <label :class="LABEL" for="boucle-mur-hashtag">Hashtag</label>
          <input id="boucle-mur-hashtag" v-model="draft.hashtag" maxlength="40" :class="FIELD" />
        </div>
      </div>

      <Empty v-if="draft.posts.length === 0">Aucun post : la boucle saute ce mur.</Empty>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(min(380px,100%),1fr))] gap-2">
        <div v-for="(post, index) in draft.posts" :key="index" :class="BOX" data-role="post">
          <div class="mb-1.5 flex items-center gap-1.5">
            <input
              :id="`boucle-post-${index}-auteur`"
              v-model="post.auteur"
              maxlength="80"
              placeholder="Auteur"
              :class="[SMALL, 'flex-1']"
            />
            <ListControls :list="draft.posts" :index="index" noun="le post" />
          </div>
          <input
            :id="`boucle-post-${index}-titre`"
            v-model="post.titre"
            maxlength="120"
            placeholder="Titre de l'auteur (poste, entreprise)"
            :class="[SMALL, 'mb-1.5 w-full']"
          />
          <ImageField :id="`boucle-post-${index}-photo`" v-model="post.photo" label="Photo" placeholder="Aucune photo" />
          <div class="mb-1.5 grid grid-cols-2 gap-1.5">
            <input
              :id="`boucle-post-${index}-date`"
              v-model="post.date"
              maxlength="40"
              placeholder="2026-10-30T10:42 ou « 2 h »"
              :class="SMALL"
            />
            <input
              :id="`boucle-post-${index}-reseau`"
              v-model="post.reseau"
              maxlength="30"
              placeholder="Réseau"
              :class="SMALL"
            />
          </div>
          <textarea
            :id="`boucle-post-${index}-texte`"
            v-model="post.texte"
            rows="4"
            maxlength="1500"
            placeholder="Texte du post"
            :class="FIELD"
          />
          <ImageField :id="`boucle-post-${index}-image`" v-model="post.image" label="Image" placeholder="Aucune image" />
          <div class="grid grid-cols-2 gap-1.5">
            <input
              :id="`boucle-post-${index}-reactions`"
              type="number"
              min="0"
              :value="post.reactions ?? ''"
              placeholder="Réactions"
              :class="SMALL"
              @change="setCount(post, 'reactions', $event)"
            />
            <input
              :id="`boucle-post-${index}-commentaires`"
              type="number"
              min="0"
              :value="post.commentaires ?? ''"
              placeholder="Commentaires"
              :class="SMALL"
              @change="setCount(post, 'commentaires', $event)"
            />
          </div>
        </div>
      </div>

      <SaveBar id="btn-boucle-mur" :dirty="dirty" @save="save">
        <Button id="btn-boucle-post-add" size="small" :disabled="draft.posts.length >= MAX_POSTS" @click="add">
          Ajouter un post
        </Button>
      </SaveBar>
    </div>
  </Panel>
</template>
