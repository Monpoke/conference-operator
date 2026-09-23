<script setup lang="ts">
import type { SponsorRef } from '@conference-operator/contract'
import { Badge } from '@conference-operator/components'
import { computed, ref, watch } from 'vue'
import { findSponsor, useBoucleStore } from '../../stores/boucle.js'
import ImageField from './ImageField.vue'
import { SMALL, orNull } from './ui.js'

/**
 * One logo placed on a page or an announcement.
 *
 * Chosen from the program's partners by key — the website, which survives the
 * export's one-identifier-per-pack — or typed as a free name for a sponsor the
 * program does not know. A name that matches a partner is recognised as it,
 * as the rooms will; one that matches nothing says so, before the room shows a
 * name in an empty circle.
 */
const model = defineModel<SponsorRef>({ required: true })
const props = defineProps<{ id: string }>()

const store = useBoucleStore()
const FREE = '__libre__'

const found = computed(() => findSponsor(model.value, store.catalogue.sponsors))
const byKey = computed(() => store.catalogue.sponsors.some((sponsor) => sponsor.key === model.value.sponsor))
const missing = computed(() => model.value.sponsor.trim() !== '' && found.value == null)

/** Free mode: the name is typed. Held locally, or choosing "Autre" would snap back. */
const free = ref(false)
watch(
  () => model.value.sponsor,
  (sponsor) => {
    if (sponsor !== '' && !byKey.value) free.value = true
  },
  { immediate: true },
)

const choice = computed(() => (free.value ? FREE : byKey.value ? model.value.sponsor : ''))

function choose(value: string): void {
  if (value === FREE) {
    free.value = true
    // Starts from the partner's name, easier to correct than an address.
    if (byKey.value) update({ sponsor: found.value?.name ?? '' })
    return
  }
  free.value = false
  update({ sponsor: value })
}

function update(patch: Partial<SponsorRef>): void {
  model.value = { ...model.value, ...patch }
}

const preview = computed(() =>
  model.value.logo != null ? store.previewOf(model.value.logo) : (found.value?.logoPreview ?? null),
)
const shownName = computed(() => model.value.nom ?? found.value?.name ?? model.value.sponsor)
const overridden = computed(() => model.value.nom != null || model.value.logo != null)
</script>

<template>
  <div class="flex flex-col gap-1.5" :data-sponsor-picker="props.id">
    <div class="flex items-center gap-1.5">
      <span
        class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-edge bg-white"
        :title="shownName"
      >
        <img
          v-if="preview != null"
          :src="preview"
          alt=""
          class="max-h-full max-w-full object-contain"
          :style="{ transform: `scale(${Math.min(1, model.echelle / 0.8)})` }"
        />
        <span v-else class="px-0.5 text-center text-[8px] leading-tight text-[#05070d]">{{ shownName }}</span>
      </span>
      <select
        :id="`${props.id}-choice`"
        :value="choice"
        :class="[SMALL, 'flex-1']"
        @change="choose(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>— Choisir un partenaire —</option>
        <option v-for="sponsor in store.catalogue.sponsors" :key="sponsor.key" :value="sponsor.key">
          {{ sponsor.name }}{{ sponsor.tiers.length > 0 ? ` (${sponsor.tiers.join(', ')})` : '' }}
        </option>
        <option :value="FREE">Autre (nom libre)…</option>
      </select>
      <Badge v-if="missing" variant="warning" class="px-2 py-0.5 text-[10px]" data-role="missing-sponsor">
        absent du programme
      </Badge>
    </div>
    <input
      v-if="free"
      :id="`${props.id}-free`"
      :value="model.sponsor"
      maxlength="200"
      placeholder="Nom du sponsor"
      :class="SMALL"
      @input="update({ sponsor: ($event.target as HTMLInputElement).value })"
    />
    <p v-if="free && found != null" class="text-xs text-dim">Reconnu : {{ found.name }}</p>
    <label class="flex items-center gap-2 text-xs text-dim">
      Taille dans le cercle
      <input
        :id="`${props.id}-echelle`"
        type="range"
        min="0.2"
        max="2"
        step="0.05"
        :value="model.echelle"
        class="flex-1"
        @input="update({ echelle: Number(($event.target as HTMLInputElement).value) })"
      />
      <input
        type="number"
        min="0.2"
        max="2"
        step="0.05"
        :value="model.echelle"
        :class="[SMALL, 'w-[70px]']"
        @change="update({ echelle: Math.min(2, Math.max(0.2, Number(($event.target as HTMLInputElement).value) || 0.7)) })"
      />
    </label>
    <details :open="overridden" class="text-xs text-dim">
      <summary class="cursor-pointer">Remplacer le nom ou le logo</summary>
      <div class="mt-1.5">
        <input
          :id="`${props.id}-nom`"
          :value="model.nom ?? ''"
          maxlength="80"
          :placeholder="found?.name ?? 'Nom affiché'"
          :class="[SMALL, 'mb-1.5 w-full']"
          @change="update({ nom: orNull(($event.target as HTMLInputElement).value) })"
        />
        <ImageField
          :id="`${props.id}-logo`"
          :model-value="model.logo"
          label="Logo"
          placeholder="Celui du programme"
          @update:model-value="update({ logo: $event })"
        />
      </div>
    </details>
  </div>
</template>
