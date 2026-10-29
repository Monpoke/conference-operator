<script setup lang="ts">
import { viewPath } from '@conference-operator/contract'
import { Button, Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { useBoucleStore } from '../../stores/boucle.js'
import SaveBar from './SaveBar.vue'
import { FIELD, LABEL, SMALL } from './ui.js'

/**
 * How the social wall's page is laid out. Its posts are not set here: they
 * come from walls.io, from the audience, and from the partner posts written in
 * Modération.
 */
/** In the page's order: what is ticked keeps it, whatever the order of the clicks. */
const RESEAUX = [
  { id: 'bluesky', nom: 'Bluesky' },
  { id: 'mastodon', nom: 'Mastodon' },
  { id: 'x', nom: 'X' },
  { id: 'linkedin', nom: 'LinkedIn' },
] as const

const store = useBoucleStore()
const toast = useToast()
const moderationPath = viewPath('moderation')
const settingsPath = viewPath('reglages')

const { draft, dirty, reset } = useDraft(() => (store.boucle == null ? null : store.boucle.wallsio))

async function save(): Promise<void> {
  if (draft.value == null) return
  try {
    await store.save('wallsio', {
      ...draft.value,
      reseaux: RESEAUX.map((reseau) => reseau.id).filter((id) => (draft.value!.reseaux ?? []).includes(id)),
      // A row left half-filled is dropped rather than refused: the panel saves what is complete.
      menu: (draft.value.menu ?? [])
        .map((lien) => ({ libelle: lien.libelle.trim(), url: lien.url.trim() }))
        .filter((lien) => lien.libelle !== '' && lien.url !== ''),
      parPage: Math.min(6, Math.max(3, Math.round(Number(draft.value.parPage) || 5))),
      sponsoriseTous: Math.min(30, Math.max(0, Math.round(Number(draft.value.sponsoriseTous) || 0))),
      dureePage: Math.min(120, Math.max(0, Math.round(Number(draft.value.dureePage) || 0))),
      ageMaxJours: Math.min(3650, Math.max(0, Math.round(Number(draft.value.ageMaxJours) || 0))),
    })
    reset()
    toast.say('Mur social enregistré')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Mur social">
    <div v-if="draft != null" id="boucle-wallsio" class="flex flex-1 flex-col">
      <p class="mb-2 text-[13px] text-dim">
        Les posts se gèrent dans <a :href="moderationPath" class="text-brand underline">Mur social</a>
        (mise en avant, posts sponsorisés et leurs affichages), le jeton walls.io dans
        <a :href="settingsPath" class="text-brand underline">Réglages</a>.
      </p>
      <label class="mb-2 flex items-center gap-2 text-sm">
        <input id="boucle-wallsio-bandeau" v-model="draft.bandeau" type="checkbox" class="w-auto" />
        Afficher le bandeau du haut (titre, hashtag) — décoché, les posts prennent sa place
      </label>
      <template v-if="draft.bandeau">
        <label :class="LABEL" for="boucle-wallsio-titre">Titre</label>
        <input id="boucle-wallsio-titre" v-model="draft.titre" maxlength="60" :class="FIELD" />
        <label :class="LABEL" for="boucle-wallsio-hashtag">Hashtag</label>
        <input id="boucle-wallsio-hashtag" v-model="draft.hashtag" maxlength="40" :class="FIELD" />
      </template>
      <label :class="LABEL" for="boucle-wallsio-accroche">
        Phrase d'accroche de la page publique — <code>{hashtag}</code> y met le hashtag ; vide, la phrase
        par défaut
      </label>
      <input
        id="boucle-wallsio-accroche"
        v-model="draft.accroche"
        maxlength="240"
        placeholder="Publiez avec {hashtag} : votre post apparaît ici, et sur les écrans des salles une fois relu."
        :class="FIELD"
      />
      <label class="mb-2 flex items-center gap-2 text-sm">
        <input id="boucle-wallsio-remplir" v-model="draft.remplir" type="checkbox" class="w-auto" />
        Remplir la page — des posts courts laissent la place à d'autres posts
      </label>
      <template v-if="!draft.remplir">
        <label :class="LABEL" for="boucle-wallsio-par-page">Posts par page (3 à 6, le post mis en avant compris)</label>
        <input
          id="boucle-wallsio-par-page"
          v-model.number="draft.parPage"
          type="number"
          min="3"
          max="6"
          :class="FIELD"
        />
      </template>
      <label :class="LABEL" for="boucle-wallsio-duree-page">
        Durée d'une page, en secondes (0 : une seule page par passage dans la boucle ; les pages
        tournent en fondu tant que le mur a le temps d'en montrer une entière)
      </label>
      <input
        id="boucle-wallsio-duree-page"
        v-model.number="draft.dureePage"
        type="number"
        min="0"
        max="120"
        :class="FIELD"
      />
      <label :class="LABEL" for="boucle-wallsio-sponsorise">
        Un post sponsorisé tous les … posts (0 : les posts partenaires ouvrent la page, comme un post
        mis en avant)
      </label>
      <input
        id="boucle-wallsio-sponsorise"
        v-model.number="draft.sponsoriseTous"
        type="number"
        min="0"
        max="30"
        :class="FIELD"
      />
      <label :class="LABEL" for="boucle-wallsio-age-max">
        Âge maximal d'un post, en jours (0 : sans limite) — au-delà, il quitte les écrans et la page publique
      </label>
      <input id="boucle-wallsio-age-max" v-model.number="draft.ageMaxJours" type="number" min="0" max="3650" :class="FIELD" />
      <label :class="LABEL" for="boucle-wallsio-affichage">Affichage sur les écrans de salle</label>
      <select id="boucle-wallsio-affichage" v-model="draft.affichage" :class="FIELD">
        <option value="pages">Pages — quelques posts, la page tourne</option>
        <option value="defilement">Mur dense — beaucoup de posts, un écran après l'autre depuis les plus récents (durée d'une page, 15 s par défaut)</option>
      </select>
      <label :class="LABEL" for="boucle-wallsio-texte-droite">
        Texte en haut à droite du mur (vide : le hashtag)
      </label>
      <input
        id="boucle-wallsio-texte-droite"
        v-model="draft.texteDroite"
        maxlength="60"
        placeholder="Tout le mur sur social.cloudnord.fr"
        :class="FIELD"
      />
      <p :class="LABEL">Boutons « Publier sur … » de la page publique</p>
      <div id="boucle-wallsio-reseaux" class="mb-[11px] flex flex-wrap gap-x-4 gap-y-1">
        <label v-for="reseau in RESEAUX" :key="reseau.id" class="flex items-center gap-1.5 text-sm" :data-reseau="reseau.id">
          <input v-model="draft.reseaux" type="checkbox" :value="reseau.id" class="w-auto" />
          {{ reseau.nom }}
        </label>
      </div>
      <p :class="LABEL">
        Menu de la page publique — les liens du site de l'événement, en ligne sur grand écran et
        derrière un menu burger sur téléphone (12 au plus, adresses en http(s)) ; vide, pas de menu
      </p>
      <div id="boucle-wallsio-menu" class="mb-2 flex flex-col gap-1.5">
        <!-- Two rows per link, the address across the panel: it holds in a narrow column as on a phone. -->
        <div
          v-for="(lien, index) in draft.menu"
          :key="index"
          class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 border-b border-edge pb-1.5"
          :data-menu-link="index"
        >
          <input v-model="lien.libelle" maxlength="40" placeholder="Programme" aria-label="Libellé du lien" :class="SMALL" class="w-full" />
          <Button variant="danger" size="small" title="Retirer ce lien" @click="draft.menu.splice(index, 1)">×</Button>
          <input
            v-model="lien.url"
            maxlength="300"
            placeholder="https://…"
            aria-label="Adresse du lien"
            :class="SMALL"
            class="col-span-2 w-full"
          />
        </div>
        <div>
          <Button id="btn-boucle-wallsio-menu-add" size="small" :disabled="draft.menu.length >= 12" @click="draft.menu.push({ libelle: '', url: '' })">
            Ajouter un lien
          </Button>
        </div>
      </div>
      <SaveBar id="btn-boucle-wallsio" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
