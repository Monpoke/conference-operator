import streamDeck, {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
} from '@elgato/streamdeck'
import { decide, faceOf, pressOf, type ButtonFace, type ButtonSettings } from '../core/buttons.js'
import { sendAction } from '../core/regie.js'
import type { RoomLink } from '../room-link.js'

/** The SDK's settings type (from `@elgato/utils`, which it does not re-export). */
type JsonValue = JsonObject | boolean | number | string | null | undefined | JsonValue[]
type JsonObject = { [key: string]: JsonValue }

/** The plugin's identifier; every action's is prefixed with it. */
export const PLUGIN_UUID = 'io.github.monpoke.conference-operator'

type Kind = ButtonSettings['kind']

/**
 * One kind of key: paints what `faceOf` says, sends what `decide` says.
 *
 * The SDK layer and nothing else — the decisions are in `core/buttons.ts`. Each
 * kind is a subclass that only names itself; its settings (the scene, the mode,
 * the source…) come from its settings panel and are merged with the kind.
 *
 * `manifestId` set as a field rather than through the `@action` decorator: it is
 * all the decorator does, and it spares the build a decorator transform.
 */
export abstract class RoomAction extends SingletonAction<JsonObject> {
  abstract readonly kind: Kind

  /** When each key went down, to tell a long press from a short one. */
  private readonly downAt = new Map<string, number>()
  /** Each visible key's settings, as last received. */
  private readonly settings = new Map<string, JsonObject>()
  /** What each key shows, to repaint only what changed. */
  private readonly painted = new Map<string, string>()

  constructor(protected readonly room: RoomLink) {
    super()
  }

  private settingsOf(id: string): ButtonSettings {
    return { ...(this.settings.get(id) ?? {}), kind: this.kind } as ButtonSettings
  }

  override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
    this.settings.set(ev.action.id, ev.payload.settings)
    this.painted.delete(ev.action.id)
    if (ev.action.isKey()) await this.paint(ev.action)
  }

  override onWillDisappear(ev: { action: { id: string } }): void {
    this.settings.delete(ev.action.id)
    this.painted.delete(ev.action.id)
    this.downAt.delete(ev.action.id)
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): Promise<void> {
    this.settings.set(ev.action.id, ev.payload.settings)
    this.painted.delete(ev.action.id)
    if (ev.action.isKey()) await this.paint(ev.action)
  }

  override onKeyDown(ev: KeyDownEvent<JsonObject>): void {
    this.downAt.set(ev.action.id, Date.now())
  }

  override async onKeyUp(ev: KeyUpEvent<JsonObject>): Promise<void> {
    const down = this.downAt.get(ev.action.id) ?? Date.now()
    this.downAt.delete(ev.action.id)
    const decision = decide(this.settingsOf(ev.action.id), this.room.state(), pressOf(down, Date.now()))
    if (decision == null) return
    if ('hint' in decision) {
      // Said on the key itself, briefly: the next state repaints it.
      await ev.action.setTitle(decision.hint.replace(/ /g, '\n'))
      await ev.action.showAlert()
      this.painted.delete(ev.action.id)
      setTimeout(() => void this.paint(ev.action), 1_500)
      return
    }
    const outcome = await sendAction(this.room.base(), decision.gesture)
    if (outcome.ok) await ev.action.showOk()
    else {
      streamDeck.logger.warn(`geste refusé (${this.kind}) : ${outcome.message}`)
      await ev.action.showAlert()
    }
  }

  /** Repaints every visible key of this kind — on each state received. */
  async refresh(): Promise<void> {
    for (const action of this.actions) {
      if (action.isKey()) await this.paint(action)
    }
  }

  private async paint(action: KeyAction<JsonObject>): Promise<void> {
    const face: ButtonFace = faceOf(this.settingsOf(action.id), this.room.state(), Date.now())
    const key = `${face.title}|${face.on}|${face.offline}`
    if (this.painted.get(action.id) === key) return
    this.painted.set(action.id, key)
    await action.setState(face.on ? 1 : 0)
    await action.setTitle(face.title)
  }
}
