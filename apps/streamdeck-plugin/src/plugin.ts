import streamDeck from '@elgato/streamdeck'
import { ACTION_CLASSES } from './actions/index.js'
import type { RoomAction } from './actions/room-action.js'
import { RoomLink } from './room-link.js'

/**
 * The plugin: one link to the room machine, nine kinds of key painted from it.
 *
 * Every state received repaints every visible key — a scene switched from the
 * control app, the console or a phone lights the matching key too. A one-second
 * tick on top keeps the recording's duration moving between two states.
 */
const actions: RoomAction[] = []
const room = new RoomLink(() => {
  for (const action of actions) void action.refresh()
})

for (const Kind of ACTION_CLASSES) {
  const action = new Kind(room)
  actions.push(action)
  streamDeck.actions.registerAction(action)
}

// The room machine's address, set from the status key's settings panel.
streamDeck.settings.onDidReceiveGlobalSettings<{ base?: string }>((ev) => room.setBase(ev.settings.base))

setInterval(() => {
  if (room.state()?.state.recording === true) {
    for (const action of actions) if (action.kind === 'recording') void action.refresh()
  }
}, 1_000)

await streamDeck.connect()
room.setBase((await streamDeck.settings.getGlobalSettings<{ base?: string }>()).base)
room.start()
