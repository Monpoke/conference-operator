<script setup lang="ts">
import { MAX_SPONSOR_PAGES, type SponsorPage, type SponsorRef } from '@conference-operator/contract'
import { Button, Empty, Panel, useToast } from '@conference-operator/components'
import { useDraft } from '../../composables/draft.js'
import { findSponsor, useBoucleStore } from '../../stores/boucle.js'
import ListControls from './ListControls.vue'
import SaveBar from './SaveBar.vue'
import SponsorPicker from './SponsorPicker.vue'
import { BOX, FIELD, SMALL } from './ui.js'

/**
 * The sponsor pages: automatic, or laid out by hand.
 *
 * Automatic is one page per tier of the program, rows of four at most — and it
 * follows the program: a sponsor added upstream appears without anybody coming
 * here. Laid out by hand, the pages are the organiser's, and a sponsor gone from
 * the program is flagged rather than silently dropped.
 */
const store = useBoucleStore()
const toast = useToast()
const MAX_ROWS = 4
const MAX_LOGOS = 12

const { draft, dirty, reset } = useDraft(() =>
  store.boucle == null ? null : { sponsorPages: store.boucle.sponsorPages },
)

const blankLogo = (): SponsorRef => ({ sponsor: '', nom: null, logo: null, echelle: 0.8 })
const blankPage = (): SponsorPage => ({ titre: '', rangs: [{ taille: 1, logos: [] }] })

/** Starts from the automatic layout: the organiser corrects rather than rebuilds. */
function customise(): void {
  if (draft.value == null) return
  const pages = JSON.parse(JSON.stringify(store.catalogue.pagesParDefaut)) as SponsorPage[]
  draft.value.sponsorPages = pages.length > 0 ? pages.slice(0, MAX_SPONSOR_PAGES) : [blankPage()]
}

function automatic(): void {
  if (draft.value != null) draft.value.sponsorPages = null
}

function nameOf(logo: SponsorRef): string {
  return logo.nom ?? findSponsor(logo, store.catalogue.sponsors)?.name ?? logo.sponsor
}

async function save(): Promise<void> {
  if (draft.value == null) return
  const pages = draft.value.sponsorPages
  if (pages?.some((page) => page.rangs.some((row) => row.logos.some((logo) => logo.sponsor.trim() === '')))) {
    toast.fail('Choisissez un partenaire pour chaque logo, ou retirez-le')
    return
  }
  try {
    await store.save('sponsorPages', pages)
    reset()
    toast.say(pages == null ? 'Pages sponsors automatiques' : 'Pages sponsors enregistrées')
  } catch {
    /* already reported */
  }
}
</script>

<template>
  <Panel title="Pages sponsors" class="col-span-full">
    <div v-if="draft != null" id="boucle-pages" class="flex flex-1 flex-col">
      <template v-if="draft.sponsorPages == null">
        <p class="mb-2 text-sm" data-role="automatic">
          <strong>Automatique (une page par palier)</strong>
          <span class="text-dim"> — suit le programme importé, rangées de quatre logos au plus.</span>
        </p>
        <Empty v-if="store.catalogue.pagesParDefaut.length === 0">
          Aucun sponsor dans le programme : la boucle saute ces pages.
        </Empty>
        <ol class="mb-2 flex flex-col gap-1 text-[13px]">
          <li v-for="(page, index) in store.catalogue.pagesParDefaut" :key="index">
            <strong>{{ page.titre === '' ? 'Sans titre' : page.titre }}</strong>
            <span class="text-dim">
              — {{ page.rangs.flatMap((row) => row.logos).map(nameOf).join(', ') }}
            </span>
          </li>
        </ol>
        <div>
          <Button id="btn-boucle-personnaliser" size="small" @click="customise">Personnaliser</Button>
        </div>
      </template>

      <template v-else>
        <div
          v-for="(page, pageIndex) in draft.sponsorPages"
          :key="pageIndex"
          :class="BOX"
          data-role="sponsor-page"
        >
          <div class="mb-1.5 flex items-start gap-1.5">
            <span class="pt-2 text-xs text-dim">Page {{ pageIndex + 1 }}</span>
            <textarea
              :id="`boucle-page-${pageIndex}-titre`"
              v-model="page.titre"
              rows="1"
              maxlength="120"
              placeholder="Titre — vide : les logos seuls"
              :class="[FIELD, 'mb-0 flex-1']"
            />
            <ListControls :list="draft.sponsorPages" :index="pageIndex" noun="la page" />
          </div>

          <div
            v-for="(row, rowIndex) in page.rangs"
            :key="rowIndex"
            class="mb-2 ml-3 border-l-2 border-edge pl-2.5"
            data-role="sponsor-row"
          >
            <div class="mb-1.5 flex items-center gap-1.5 text-xs text-dim">
              Rangée {{ rowIndex + 1 }} — taille des cercles
              <input
                :id="`boucle-page-${pageIndex}-rang-${rowIndex}-taille`"
                v-model.number="row.taille"
                type="number"
                min="0.3"
                max="2"
                step="0.1"
                :class="[SMALL, 'w-[70px]']"
              />
              <span class="min-w-0 flex-1" />
              <ListControls :list="page.rangs" :index="rowIndex" noun="la rangée" />
            </div>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-2">
              <div
                v-for="(_, logoIndex) in row.logos"
                :key="logoIndex"
                class="flex items-start gap-1.5 rounded-lg bg-surface2 p-2"
              >
                <SponsorPicker
                  :id="`boucle-page-${pageIndex}-rang-${rowIndex}-logo-${logoIndex}`"
                  v-model="row.logos[logoIndex]!"
                  class="min-w-0 flex-1"
                />
                <ListControls :list="row.logos" :index="logoIndex" noun="le logo" />
              </div>
            </div>
            <Button
              size="small"
              class="mt-1.5"
              :disabled="row.logos.length >= MAX_LOGOS"
              data-action="add-logo"
              @click="row.logos.push(blankLogo())"
            >
              Ajouter un logo
            </Button>
          </div>
          <Button
            size="small"
            :disabled="page.rangs.length >= MAX_ROWS"
            data-action="add-row"
            @click="page.rangs.push({ taille: 1, logos: [] })"
          >
            Ajouter une rangée
          </Button>
        </div>
        <div class="flex gap-1.5">
          <Button
            id="btn-boucle-page-add"
            size="small"
            :disabled="draft.sponsorPages.length >= MAX_SPONSOR_PAGES"
            @click="draft.sponsorPages.push(blankPage())"
          >
            Ajouter une page
          </Button>
          <Button id="btn-boucle-automatique" size="small" @click="automatic">Revenir à l'automatique</Button>
        </div>
      </template>

      <SaveBar id="btn-boucle-pages" :dirty="dirty" @save="save" />
    </div>
  </Panel>
</template>
