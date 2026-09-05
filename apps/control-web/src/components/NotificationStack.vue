<script setup lang="ts">
import { NOTIFICATION_TTL_MS, type DisplayPayload } from '@conference-operator/contract'
import { time } from '@conference-operator/format'
import { computed, ref } from 'vue'
import { useActionsStore } from '../stores/actions.js'

/**
 * What has just happened next door.
 *
 * These cards appear for thirty seconds at the bottom of a screen nobody is
 * looking at — during a talk the operator watches the room. Hence a **solid**
 * background, and not a muted tint like the rest of the page: what must be seen
 * out of the corner of the eye is seen by colour, not by text. The text goes
 * dark, the only pairing that stays readable on amber.
 *
 * Thirty seconds, because a banner that does not go away stops being read: the
 * control app used to end the day with five notices stacked above the commands,
 * all long expired. What must stay consultable — the other rooms' state — is in
 * the header strip anyway, and that does not expire.
 */
const TINTS: Record<string, string> = {
  info: 'bg-brand text-[#05070d]',
  warning: 'bg-warn text-[#05070d]',
}

const props = defineProps<{ payload: DisplayPayload; nowMs: number }>()

const actions = useActionsStore()

/**
 * Dismissed by hand, while the removal makes its way round.
 *
 * The state goes on pushing them until the request reaches the runtime: without
 * this list, the cross would give the notice back for a second.
 */
const dismissed = ref<string[]>([])

const notices = computed(() =>
  (props.payload.state.notifications ?? []).filter(
    (notice) =>
      !dismissed.value.includes(notice.id) &&
      Date.parse(notice.at) > props.nowMs - NOTIFICATION_TTL_MS,
  ),
)

async function dismiss(id: string): Promise<void> {
  dismissed.value = [...dismissed.value, id]
  const result = await actions.act({ action: 'notification.dismiss', id }, { silent: true })

  /*
   * Refused: we put it back.
   *
   * The local dismissal exists to cover the round trip, not to erase what the
   * runtime kept. Without this reversal, a notice the machine refuses to forget
   * would stay invisible until the page is reloaded — hidden from whoever
   * dismissed it, and still there for everybody else.
   */
  if (!result.ok) dismissed.value = dismissed.value.filter((other) => other !== id)
}
</script>

<template>
  <div
    v-if="notices.length > 0"
    class="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-2 px-4"
    data-role="notifications"
  >
    <!--
      The whole card is the button, and not only its cross.
      A notice is read at a glance and swept aside with a flick of the mouse,
      while holding the microphone. Aiming at a twelve-pixel cross in a dark room
      means stopping and looking — that is, taking one's eyes off what is
      happening on stage, for a gesture that does not deserve it.

      A `<button>` rather than a `<div>` listening for the click: it takes keyboard
      focus, announces itself as actionable, and answers Enter. The cross stays,
      decorative — it is what says the card can be closed.
    -->
    <button
      v-for="notice in notices"
      :key="notice.id"
      type="button"
      class="pointer-events-auto flex w-auto shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border-0 px-3.5 py-2 text-left text-[13px] font-medium shadow-[0_10px_30px_rgba(0,0,0,.45)]"
      :class="TINTS[notice.level] ?? TINTS.info"
      :data-notification="notice.id"
      :title="`Écarter : ${notice.text}`"
      @click="dismiss(notice.id)"
    >
      <span class="text-xs tabular-nums opacity-60">{{ time(notice.at, payload.timezone) }}</span>
      <span>{{ notice.text }}</span>
      <!-- Inherits the block's colour: the dimmed tone is readable on the page's
           dark background, not on a solid one. -->
      <span class="ml-auto px-1.5 py-0.5 text-current opacity-60" aria-hidden="true">×</span>
    </button>
  </div>
</template>
