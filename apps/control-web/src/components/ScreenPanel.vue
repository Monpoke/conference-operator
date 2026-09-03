<script setup lang="ts">
import { Panel } from '@cloudnord/components'
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
  { value: 'countdown', label: 'Compte à rebours' },
  { value: 'message', label: 'Message' },
  // End of talk: the audience is still seated, and it is the only moment feedback
  // actually comes in.
  { value: 'feedback', label: 'Notez le talk' },
  { value: 'wall', label: 'Mur & questions' },
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
   * Served by the hub, on a phone.
   *
   * The mode arrives there through the room's heartbeat, so slightly behind a
   * switch decided on site. The button does not anticipate for all that — here as
   * elsewhere, a lit button describes what the room is showing, not what it was
   * asked to show.
   */
  remote?: boolean
}>()

const commands = computed<Command[]>(() =>
  props.remote === true ? MODES.filter((m) => !NOTHING_TO_SHOW_REMOTELY.includes(m.value)) : MODES,
)
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
