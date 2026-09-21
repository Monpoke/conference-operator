<script setup lang="ts">
import { Panel } from '@conference-operator/components'
import { computed } from 'vue'
import CommandGrid, { type Command } from './CommandGrid.vue'

/**
 * What the room sees.
 *
 * The loop first: it is the default waiting screen, the one one comes back to.
 * The pages it cycles through stay available on their own, so the screen can be
 * frozen on one of them when something happens.
 */
const MODES: Command[] = [
  { value: 'loop', label: 'Boucle' },
  { value: 'sponsors', label: 'Sponsors' },
  { value: 'programme', label: 'Programme' },
  // The same day in two columns, offered alongside rather than in place: the two
  // layouts are compared on the room's own video projector, and it is there that
  // one of them is chosen.
  { value: 'agenda', label: 'Agenda (2 colonnes)' },
  { value: 'countdown', label: 'Compte à rebours' },
  { value: 'message', label: 'Message' },
  // End of talk: the audience is still seated, and it is the only moment feedback
  // actually comes in.
  { value: 'feedback', label: 'Notez le talk' },
  { value: 'wall', label: 'Mur & questions' },
  // Our wall and the social one sit side by side: one is the room talking to the
  // room, the other the event seen from outside. Neither replaces the other.
  { value: 'wallsio', label: 'Mur social' },
  { value: 'question', label: 'Question choisie' },
]

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

const commands = computed<Command[]>(() => {
  const withdrawn = props.disabled ?? []
  return MODES.filter(
    (m) =>
      (!withdrawn.includes(m.value) || m.value === props.mode)
      && (props.remote !== true || !NOTHING_TO_SHOW_REMOTELY.includes(m.value)),
  )
})
</script>

<template>
  <Panel title="Écran de salle">
    <CommandGrid
      :commands="commands"
      :current="mode"
      :build="(value) => ({ action: 'display.set', mode: value })"
    />
  </Panel>
</template>
