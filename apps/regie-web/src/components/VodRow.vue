<script setup lang="ts">
import type { EntreeVod } from '@cloudnord/contract'
import { Button } from '@cloudnord/components'
import { fileSize, remaining, shortDuration, time } from '@cloudnord/format'
import { computed } from 'vue'
import { UPLOAD_WORDS, VERDICT_BADGES, useVodStore } from '../stores/vod.js'
import VodPreview from './VodPreview.vue'

const props = defineProps<{ entry: EntreeVod; timeZone: string }>()

const vod = useVodStore()

const check = computed(() => props.entry.check)
const sidecar = computed(() => props.entry.sidecar)
const upload = computed(() => vod.uploadOf(props.entry.file))

/**
 * Ce qu'il reste à attendre sur ce rush, en clair — ou rien à dire.
 *
 * C'est la réponse à la question du démontage, celle que le pourcentage laisse
 * entière : 60 % sur un rush de quatre gigas, c'est deux minutes ou quarante.
 * Le calcul est au magasin, qui seul voit passer les relevés successifs et peut
 * les lisser ; ici on ne fait que le lire.
 */
const eta = computed(() => {
  const ms = vod.etaOf(props.entry.file)
  return ms == null ? null : remaining(ms)
})

const badge = computed(
  () => VERDICT_BADGES[check.value?.status ?? ''] ?? ['Non vérifié', 'border-bord text-attenue'],
)

const durationMs = computed(
  () => check.value?.probe?.durationMs ?? sidecar.value?.durationMs ?? null,
)

const speakers = computed(() =>
  (sidecar.value?.speakers ?? [])
    .map((person) => person.name)
    .filter(Boolean)
    .join(', '),
)

/** Ce qui se lit d'un coup d'œil : quand, combien, et ce qui manque déjà. */
const details = computed(() => {
  const parts: string[] = []
  if (sidecar.value == null) parts.push('sidecar absent')
  else {
    parts.push(time(sidecar.value.startedAt, props.timeZone))
    const poses = sidecar.value.markers ?? []
    const chapitres = poses.filter((marker) => marker.role == null).length
    if (chapitres > 0) parts.push(`${chapitres} marqueur${chapitres > 1 ? 's' : ''}`)

    /*
     * Ce que le montage coupera, quand la régie le lui a dit.
     *
     * C'est la seule fenêtre où l'information est encore vérifiable : le rush
     * s'ouvre ici, et l'aperçu est à un clic. Trois semaines plus tard, un
     * repère posé une minute trop tôt se découvre sur la vidéo publiée.
     *
     * Rien d'affiché quand aucun repère n'a été posé : la prise est terminée,
     * on ne peut plus en poser, et un reproche sans remède n'apprend rien de ce
     * qu'on est venu vérifier ici.
     */
    const debut = poses.find((marker) => marker.role === 'debut')
    const fin = poses.find((marker) => marker.role === 'fin')
    if (debut != null || fin != null) {
      const borne = (marker: typeof debut): string =>
        marker == null ? '?' : shortDuration(marker.offsetMs)
      parts.push(`rognage ${borne(debut)} → ${borne(fin)}`)
    }
  }
  if (durationMs.value != null) parts.push(shortDuration(durationMs.value))
  parts.push(fileSize(props.entry.sizeBytes))
  if (props.entry.enEcriture) parts.push('encore en écriture')
  if (check.value?.by === 'operateur') parts.push('verdict de la régie')

  /*
   * L'état de montée se lit dans la même ligne que le reste : c'est la même
   * question — « ce rush est-il en sécurité ? » — et la séparer en deux
   * colonnes obligerait à croiser deux listes des yeux.
   */
  const state = upload.value?.state
  if (state != null) {
    const word = UPLOAD_WORDS[state] ?? state
    if (state !== 'en-cours') parts.push(word)
    else {
      const reste = eta.value == null ? '' : ` · reste ${eta.value}`
      parts.push(`${word} — ${upload.value?.pourcent} %${reste}`)
    }
  }
  return parts.join(' · ')
})

/**
 * Ce que le témoin de progression dit au survol.
 *
 * Le pourcentage est déjà dans la ligne de détail, mais elle se lit à la
 * recherche d'un fichier, pas d'un chiffre. Sur le témoin, il est là où le
 * regard se pose quand on se demande « et celui-là, il en est où ? ».
 *
 * « environ » n'est pas une précaution de style : le temps annoncé vaut ce que
 * vaut le réseau des trois dernières minutes, et l'opérateur qui décide de
 * débrancher un disque doit lire une estimation comme une estimation.
 */
const progressTitle = computed(() => {
  if (upload.value?.state === 'attente') {
    return 'En file : le téléversement partira dès que la salle le permet'
  }
  const reste = eta.value == null ? '' : `, reste environ ${eta.value}`
  return `Téléversement en cours — ${upload.value?.pourcent ?? 0} %${reste}`
})

/**
 * Une case carrée, la même pour les quatre icônes.
 *
 * Sans elle, chaque bouton était large de son glyphe : 👁 et ⬆ sont des emoji,
 * ✓ et ✕ des caractères de texte bien plus étroits, et `px-3` de chaque côté
 * n'y changeait rien. Quatre boutons de quatre largeurs, décalés d'une ligne à
 * l'autre dès que le reste bougeait. La largeur est donc fixée ici, une fois,
 * et `px-0` retire le rembourrage qui la faisait dépendre du contenu.
 */
const CASE_ICONE = 'w-9 px-0'

/**
 * La colonne du téléversement, à largeur réservée.
 *
 * C'est elle qui décalait tout le reste : elle porte tantôt un ⬆, tantôt un ☁,
 * tantôt un témoin **et** un bouton « Annuler » — trois largeurs très
 * différentes, donc un ✓ et un ✕ qui ne tombaient au même endroit sur aucune
 * ligne. La place du cas le plus large est réservée sur toutes les lignes, et
 * le contenu est poussé à droite : ⬆, ☁ et « Annuler » partagent ainsi leur
 * bord droit, celui qui touche le ✓.
 */
const COLONNE_MONTEE = 'flex w-[6.75rem] shrink-0 items-center justify-end gap-1'

/** « Actif » sur le verdict déjà posé : le même bouton l'enlève. */
function posed(status: string): boolean {
  return check.value?.by === 'operateur' && check.value.status === status
}
</script>

<template>
  <div
    class="grid grid-cols-[1fr_auto] items-start gap-3 rounded-lg border border-bord p-2.5"
    :data-vod="entry.file"
  >
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <!--
          Largeur fixe, comme les icônes d'en face et pour la même raison :
          « Non vérifié », « Exploitable », « À revoir » et « Illisible » n'ont
          pas la même longueur, et le nom de fichier commençait donc à quatre
          abscisses différentes selon le verdict. Sur une liste qu'on parcourt
          en diagonale, c'est ce décalage qui se voit avant le badge lui-même.
        -->
        <span
          class="w-24 shrink-0 rounded border px-1.5 py-px text-center text-[10px] font-semibold tracking-[.08em] uppercase"
          :class="badge[1]"
          data-role="vod-badge"
        >
          {{ badge[0] }}
        </span>
        <span class="truncate font-mono text-[12px] text-attenue">{{ entry.file }}</span>
      </div>
      <div class="mt-1 truncate text-sm">
        {{ sidecar?.title ?? 'Titre inconnu' }}
        <span v-if="speakers !== ''" class="text-attenue"> — {{ speakers }}</span>
      </div>
      <div class="mt-0.5 text-[11px] text-attenue">{{ details }}</div>

      <!-- Un badge rouge sans raison ne sert personne. -->
      <div
        v-if="(check?.reasons.length ?? 0) > 0"
        class="mt-1 text-[11px]"
        :class="check?.status === 'ok' ? 'text-attenue' : 'text-attention'"
      >
        {{ check?.reasons.join(' · ') }}
      </div>

      <!-- « AccessDenied » est le seul mot qu'on puisse porter à qui tient le
           bucket : le traduire ferait perdre la seule prise sur le problème. -->
      <div v-if="upload?.erreur != null" class="mt-1 text-[11px] text-alerte">
        Téléversement : {{ upload.erreur }}
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <Button
        size="small"
        :class="CASE_ICONE"
        title="Voir et entendre un extrait"
        :active="vod.preview?.file === entry.file"
        :data-vod-apercu="entry.file"
        @click="vod.togglePreview(entry.file)"
      >
        👁
      </Button>
      <Button
        size="small"
        title="Relit le conteneur : pistes, durée réelle, débit"
        :data-vod-inspect="entry.file"
        @click="vod.inspect(entry.file)"
      >
        Vérifier
      </Button>

      <!--
        Le même emplacement à travers toute la vie d'un rush : ⬆, puis un témoin
        de progression, puis ☁. Le ⬆ disparaissait au profit d'« Annuler », et
        la ligne perdait d'un coup le seul repère qui disait où en était ce
        fichier-là : sur une modale qui en aligne quinze, il fallait relire le
        détail en petit pour retrouver celui qui montait. Le témoin garde la
        place et porte l'avancement.

        Il n'est **pas** cliquable, et c'est délibéré : « Annuler » reste un
        bouton nommé, à côté. Un témoin qui annulerait au clic ferait perdre
        trois gigaoctets déjà montés à un doigt distrait — exactement ce que le
        ☁ sans bouton évite à l'autre bout.

        Tout l'ensemble est absent tant que le hub n'a pas de destination : un
        bouton qui échoue à chaque clic est pire qu'un bouton absent, et
        l'en-tête dit déjà pourquoi.
      -->
      <div v-if="vod.blocked == null" :class="COLONNE_MONTEE">
        <template v-if="upload?.state === 'en-cours' || upload?.state === 'attente'">
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center"
            :title="progressTitle"
            :data-vod-progression="entry.file"
          >
            <!--
              Deux allures pour deux états, parce qu'ils ne disent pas la même
              chose : ça tourne quand des octets partent, ça bat quand on attend
              une fenêtre. Un anneau qui tourne sur une file d'attente ferait
              croire à une montée qui n'avance pas.
            -->
            <span
              class="h-3.5 w-3.5 rounded-full border-2 border-bord"
              :class="
                upload?.state === 'en-cours'
                  ? 'animate-spin border-t-marque'
                  : 'animate-pulse border-t-attention'
              "
            ></span>
          </span>
          <Button
            size="small"
            title="Renoncer à ce téléversement"
            :data-vod-annuler="entry.file"
            @click="vod.cancelUpload(entry.file)"
          >
            Annuler
          </Button>
        </template>
        <span
          v-else-if="upload?.state === 'termine'"
          class="flex w-9 shrink-0 justify-center text-[13px] text-attenue"
          title="Rush et sidecar déjà envoyés : rien à faire de plus"
        >
          ☁
        </span>
        <Button
          v-else
          size="small"
          :class="CASE_ICONE"
          :title="
            entry.enEcriture
              ? 'Prise encore en cours : le fichier partira une fois arrêtée'
              : 'Envoyer ce rush et son sidecar au stockage'
          "
          :data-vod-monter="entry.file"
          @click="vod.upload(entry.file)"
        >
          ⬆
        </Button>
      </div>

      <Button
        size="small"
        :class="CASE_ICONE"
        title="Fichier ouvert et relu : exploitable"
        :active="posed('ok')"
        :data-vod-verdict-ok="entry.file"
        @click="vod.verdict(entry.file, 'ok')"
      >
        ✓
      </Button>
      <Button
        size="small"
        :class="CASE_ICONE"
        title="Fichier inexploitable : à refaire ou à signaler"
        :active="posed('illisible')"
        :data-vod-verdict-ko="entry.file"
        @click="vod.verdict(entry.file, 'illisible')"
      >
        ✕
      </Button>
    </div>

    <VodPreview v-if="vod.preview?.file === entry.file" :entry="entry" />
  </div>
</template>
