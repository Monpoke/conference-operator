<script setup lang="ts">
import { Button, useToast } from '@conference-operator/components'
import { computed, ref, watch } from 'vue'
import { ImageRefused, useBoucleStore } from '../../stores/boucle.js'
import { LABEL, SMALL, orNull } from './ui.js'

/**
 * An image of the loop: an address, or a file dropped from this machine.
 *
 * Both end up in the hub's asset store, and the rooms read them from there — an
 * address is downloaded by the hub, a file is uploaded to it. What the preview
 * shows is the hub's copy when it has one.
 */
const model = defineModel<string | null>({ required: true })
const props = defineProps<{
  id: string
  label: string
  /** What an empty field means — "le logo du programme", "aucune photo". */
  placeholder?: string
}>()

const store = useBoucleStore()
const toast = useToast()

const uploaded = computed(() => model.value?.startsWith('hub-image:') === true)
const text = ref('')
watch(
  model,
  (value) => {
    text.value = value == null || value.startsWith('hub-image:') ? '' : value
  },
  { immediate: true },
)
const invalid = computed(() => text.value.trim() !== '' && !/^https?:\/\//.test(text.value.trim()))
const preview = computed(() => store.previewOf(model.value))

function commit(): void {
  // An upload stays until it is removed: an empty address field under it means
  // "no address", not "no image".
  if (uploaded.value && text.value.trim() === '') return
  if (invalid.value) return
  model.value = orNull(text.value)
}

const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function pick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file == null) return
  busy.value = true
  try {
    model.value = await store.upload(file)
  } catch (cause) {
    // The hub's refusals are already reported by the client's hook.
    if (cause instanceof ImageRefused) toast.fail(cause.message)
  } finally {
    busy.value = false
    input.value = ''
  }
}
</script>

<template>
  <div class="mb-[11px]" :data-image-field="props.id">
    <label :class="LABEL" :for="props.id">{{ props.label }}</label>
    <div class="flex items-center gap-1.5">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-edge bg-white"
      >
        <img v-if="preview != null" :src="preview" alt="" class="max-h-full max-w-full object-contain" />
        <span v-else-if="model != null" class="text-[10px] text-alert" title="Le hub n'a pas cette image">?</span>
      </span>
      <input
        :id="props.id"
        v-model="text"
        type="url"
        :placeholder="uploaded ? 'Image déposée' : (props.placeholder ?? 'https://…')"
        :class="[SMALL, 'flex-1']"
        @change="commit"
      />
      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        class="hidden"
        :data-upload="props.id"
        @change="pick"
      />
      <Button size="small" :disabled="busy" title="Déposer un fichier" @click="fileInput?.click()">
        {{ busy ? '…' : 'Fichier' }}
      </Button>
      <Button v-if="model != null" size="small" variant="danger" title="Retirer l'image" @click="model = null">
        ×
      </Button>
    </div>
    <p v-if="invalid" class="mt-1 text-xs text-warn">Adresse http(s) attendue.</p>
  </div>
</template>
