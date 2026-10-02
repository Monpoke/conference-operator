import { PLUGIN_UUID, RoomAction } from './room-action.js'

/** One class per kind of key: a name in the manifest, a kind in `core/buttons.ts`. */

export class SceneAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.scene`
  readonly kind = 'scene' as const
}

export class SceneToggleAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.scene-toggle`
  readonly kind = 'scene-toggle' as const
}

export class DisplayAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.display`
  readonly kind = 'display' as const
}

export class RecordingAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.recording`
  readonly kind = 'recording' as const
}

export class MarkAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.mark`
  readonly kind = 'mark' as const
}

export class StreamAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.stream`
  readonly kind = 'stream' as const
}

export class MicAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.mic`
  readonly kind = 'mic' as const
}

export class SessionAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.session`
  readonly kind = 'session' as const
}

export class MessageClearAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.message-clear`
  readonly kind = 'message-clear' as const
}

export class StatusAction extends RoomAction {
  override readonly manifestId = `${PLUGIN_UUID}.status`
  readonly kind = 'status' as const
}

export const ACTION_CLASSES = [
  SceneAction,
  SceneToggleAction,
  DisplayAction,
  RecordingAction,
  MarkAction,
  StreamAction,
  MicAction,
  SessionAction,
  MessageClearAction,
  StatusAction,
] as const
