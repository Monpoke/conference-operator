import { resolveEventIdentity, type EventIdentity } from '@conference-operator/contract'
import type { ProgramService } from './program.js'
import type { SettingsService } from './sessions.js'

/**
 * Who the event is, for everything the hub shows or sends.
 *
 * The hub decides, once, and everything else consumes the result: the public
 * wall, the console, the notifications service worker, and the rooms' `sync`.
 * Deriving it separately in each page made the product unrenameable — that is
 * exactly the defect this service removes.
 *
 * Two sources and one order: the hub's setting if there is one, else the
 * imported program. The second is the normal case, and it is what makes the
 * repository agnostic: importing another event's export renames everything.
 *
 * Read on every use rather than cached, like the settings it depends on: the
 * name gets corrected during the event, and seeing it persist ten seconds after
 * changing it would cast doubt on whether the setting was taken.
 */
export class EventIdentityService {
  constructor(
    private readonly settings: SettingsService,
    private readonly programs: ProgramService,
  ) {}

  /**
   * What the hub would settle on **without** a setting.
   *
   * Used by the console, which shows it as the `placeholder` of fields left
   * empty: without it, an operator cannot know what they will get by clearing
   * the field, and so does not dare clear it — and the setting becomes a
   * one-way trip.
   */
  derived(): EventIdentity {
    return resolveEventIdentity({ program: this.programs.activeEventName() })
  }

  get(): EventIdentity {
    const settings = this.settings.get()
    return resolveEventIdentity({
      setting: { name: settings.eventName, shortName: settings.eventShortName },
      program: this.programs.activeEventName(),
    })
  }
}
