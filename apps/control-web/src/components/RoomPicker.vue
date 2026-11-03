<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'

/**
 * Choosing a room by typing part of its name.
 *
 * Not a native `<select>`: in an OBS dock the native dropdown opens empty even
 * though the rooms are known. And not a row of buttons either: with a dozen rooms
 * the row took the dialog's header. A field that filters a list does both — it
 * works in the dock, and it stays one line however many rooms there are.
 *
 * The field is an `<input>`: the page's one-letter shortcuts leave it alone, so
 * typing « l » to find « Salle L » never switches the projection.
 */
const props = defineProps<{
  rooms: { id: string; name: string }[]
  selected: string | null
}>()

const emit = defineEmits<{ choose: [roomId: string] }>()

const listId = useId()
const query = ref('')
const open = ref(false)
const highlighted = ref(0)

/** Accents and case ignored: « amphi st » finds « Amphi St Louis ». */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

const matches = computed(() => {
  const words = fold(query.value).split(/\s+/).filter((word) => word !== '')
  return props.rooms.filter((room) => {
    const haystack = fold(`${room.name} ${room.id}`)
    return words.every((word) => haystack.includes(word))
  })
})

const selectedName = computed(
  () => props.rooms.find((room) => room.id === props.selected)?.name ?? '',
)

watch(matches, () => (highlighted.value = 0))

function show(): void {
  open.value = true
  query.value = ''
}

function choose(roomId: string): void {
  emit('choose', roomId)
  open.value = false
  query.value = ''
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!open.value) return show()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const count = matches.value.length
    if (count > 0) highlighted.value = (highlighted.value + step + count) % count
  } else if (event.key === 'Enter') {
    const room = matches.value[highlighted.value]
    if (open.value && room != null) {
      event.preventDefault()
      choose(room.id)
    }
  } else if (event.key === 'Escape' && open.value) {
    // The list closes first; the dialog behind it stays open.
    event.stopPropagation()
    event.preventDefault()
    open.value = false
    query.value = ''
  }
}
</script>

<template>
  <div class="w-[min(22rem,100%)]" data-role="room-picker">
    <input
      type="search"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-label="Rechercher une salle"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && matches[highlighted] != null ? `${listId}-${matches[highlighted]!.id}` : undefined"
      :placeholder="selectedName === '' ? 'Rechercher une salle…' : selectedName"
      :value="open ? query : selectedName"
      class="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-text placeholder:text-dim focus:border-brand focus:outline-none"
      data-role="room-picker-input"
      @focus="show()"
      @click="open || show()"
      @input="query = ($event.target as HTMLInputElement).value; open = true"
      @keydown="onKeydown"
      @blur="open = false"
    />
    <!--
      In the flow, not floating: the dialog clips what overflows it, and with no
      room chosen yet its body is one line tall — a floating list showed one room.
    -->
    <ul
      v-if="open"
      :id="listId"
      role="listbox"
      class="mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-edge bg-surface p-1"
      data-role="room-picker-list"
    >
      <li v-if="matches.length === 0" class="px-3 py-2 text-sm text-dim">
        Aucune salle ne correspond.
      </li>
      <!-- `mousedown`, not `click`: the field's blur would close the list first. -->
      <li
        v-for="(room, index) in matches"
        :id="`${listId}-${room.id}`"
        :key="room.id"
        role="option"
        :aria-selected="room.id === selected"
        class="cursor-pointer rounded-md px-3 py-2 text-sm"
        :class="[
          index === highlighted ? 'bg-edge text-text' : 'text-text',
          room.id === selected ? 'font-semibold' : '',
        ]"
        :data-room="room.id"
        @mousedown.prevent="choose(room.id)"
        @mousemove="highlighted = index"
      >
        {{ room.name }}
      </li>
    </ul>
  </div>
</template>
