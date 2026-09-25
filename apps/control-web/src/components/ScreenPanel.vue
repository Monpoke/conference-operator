<script setup lang="ts">
import { Panel } from '@conference-operator/components'
import { computed } from 'vue'
import CommandGrid, { type Command } from './CommandGrid.vue'

/**
 * What the room sees, in two groups.
 *
 * The loop first: it is the default waiting screen, the one one comes back to.
 * The pages it cycles through stay reachable on their own — the sponsors, the
 * social wall, the agenda — so the screen can be frozen on one of them when
 * something happens. They are the loop's own scenes: putting one up shows
 * exactly what the loop shows.
 */
const BOUCLE: Command[] = [
  { value: 'loop', label: 'Boucle entière' },
  { value: 'sponsors', label: 'Sponsors' },
  // Our wall and the social one are both offered: one is the room talking to the
  // room, the other the event seen from outside. Neither replaces the other.
  { value: 'wallsio', label: 'Mur social' },
  { value: 'agenda', label: 'Agenda' },
]

/** The screens the operator puts up for a moment of the talk. */
const OPERATEUR: Command[] = [
  { value: 'countdown', label: 'Compte à rebours' },
  { value: 'message', label: 'Message' },
  // End of talk: the audience is still seated, and it is the only moment feedback
  // actually comes in.
  { value: 'feedback', label: 'Notez le talk' },
  { value: 'wall', label: 'Mur & questions' },
  { value: 'question', label: 'Question choisie' },
]

/**
 * The single-column programme, no longer offered: the loop's agenda took its
 * place. A room can still be on it — put up from its own control app, or before
 * the change — and the lit button must then still say so, and be there to leave.
 */
const PROGRAMME: Command = { value: 'programme', label: 'Programme' }

/**
 * The two modes that display something chosen elsewhere.
 *
 * `message` shows the banner typed in the Message panel, `question` the question
 * picked in the room control app's moderation — neither is offered remotely.
 * Offering them anyway would give a button that takes over the room's screen to
 * project "Aucune question affichée" in front of the audience: the gesture would
 * succeed, and that is exactly what makes it bad.
 */
const NOTHING_TO_SHOW_REMOTELY = ['message', 'question']

const props = defineProps<{
  mode: string | null
  /**
   * The screens this edition withdrew, decided on the hub.
   *
   * Filtered out rather than greyed out: a disabled button asks the question
   * "why?" in front of a room, and the answer is on another machine. An edition
   * with no sponsors simply has no sponsors button.
   *
   * It never hides the screen **currently** on air, however it got there: a lit
   * button describes what the room is showing, and a screen withdrawn while it
   * was up must not vanish from the console that is showing it — the operator
   * would have no way left to read, or to leave, the state they are in.
   */
  disabled?: string[]
  /**
   * Served by the hub, on a phone.
   *
   * The mode arrives there through the room's heartbeat, so slightly behind a
   * switch decided on site. The button does not anticipate for all that — here as
   * elsewhere, a lit button describes what the room is showing, not what it was
   * asked to show.
   */
  remote?: boolean
}>()

function visible(list: Command[]): Command[] {
  const withdrawn = props.disabled ?? []
  return list.filter(
    (m) =>
      (!withdrawn.includes(m.value) || m.value === props.mode)
      && (props.remote !== true || !NOTHING_TO_SHOW_REMOTELY.includes(m.value)),
  )
}

const groups = computed(() => [
  { title: 'Boucle', commands: visible(BOUCLE) },
  {
    title: 'Opérateur',
    commands: visible(props.mode === PROGRAMME.value ? [...OPERATEUR, PROGRAMME] : OPERATEUR),
  },
].filter((group) => group.commands.length > 0))
</script>

<template>
  <Panel title="Écran de salle">
    <section v-for="group in groups" :key="group.title" :data-group="group.title" class="not-first:mt-3">
      <h3 class="mb-1.5 text-[11px] font-semibold tracking-[.14em] text-dim uppercase">
        {{ group.title }}
      </h3>
      <CommandGrid
        :commands="group.commands"
        :current="mode"
        :build="(value) => ({ action: 'display.set', mode: value })"
      />
    </section>
  </Panel>
</template>
