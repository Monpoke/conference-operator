import {
  boucleImageRefs,
  type Boucle,
  type SponsorPage,
  type SponsorRef,
} from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * The welcome loop's content, as the « Boucle » view edits it.
 *
 * A hub setting like the others — read through `settings.get`, written through
 * `settings.update` — but saved **one section at a time**: the hub merges
 * `boucle` section by section, so a panel sends what it carries and nothing
 * else. Saving the animated messages must not take the sponsor pages back to
 * their automatic layout.
 */
export interface CatalogueSponsor {
  key: string
  name: string
  website: string | null
  logoPreview: string | null
  tiers: string[]
}

export interface Catalogue {
  sponsors: CatalogueSponsor[]
  pagesParDefaut: SponsorPage[]
}

/** A reference is at most this long once in base64 — the contract's ceiling. */
const MAX_BASE64 = 3_000_000
/** The side an uploaded image is reduced to: twice what a 1920 stage shows of a logo. */
export const MAX_IMAGE_SIDE = 1600

export const useBoucleStore = defineStore('boucle', () => {
  const boucle = ref<Boucle | null>(null)
  const catalogue = ref<Catalogue>({ sponsors: [], pagesParDefaut: [] })
  /** For the feedbacks QR's placeholder: what the rooms draw when no address is set. */
  const openFeedbackProjectId = ref<string | null>(null)
  /** Reference → where the console shows it from. `null` = the hub lost it. */
  const previews = ref<Record<string, string | null>>({})
  /** Bumped on every save: the preview reloads on it. */
  const revision = ref(0)

  const session = useSessionStore()

  async function load(): Promise<void> {
    const [settings, catalogueData] = await Promise.all([
      session.client.rpc.settings.get(),
      session.client.rpc.boucle.catalogue(),
    ])
    boucle.value = settings.boucle
    openFeedbackProjectId.value = settings.openFeedbackProjectId ?? null
    catalogue.value = catalogueData
    await loadPreviews()
  }

  /** Asks only for the references not seen yet: the answer does not move. */
  async function loadPreviews(extra: string[] = []): Promise<void> {
    const refs = [...(boucle.value == null ? [] : boucleImageRefs(boucle.value)), ...extra].filter(
      (ref) => !(ref in previews.value),
    )
    if (refs.length === 0) return
    const answer = await session.client.rpc.boucle.previews({ refs: [...new Set(refs)].slice(0, 200) })
    previews.value = { ...previews.value, ...answer }
  }

  /**
   * Saves some sections, then lays down what the hub answered.
   *
   * The sections not named are left as the hub has them — that is the whole
   * contract of `boucle` in `settings.update`.
   */
  async function saveSections(patch: Partial<Boucle>): Promise<void> {
    const settings = await session.client.rpc.settings.update({ boucle: patch })
    boucle.value = settings.boucle
    revision.value += 1
    await loadPreviews()
  }

  async function save<K extends keyof Boucle>(section: K, value: Boucle[K]): Promise<void> {
    await saveSections({ [section]: value } as Partial<Boucle>)
  }

  /**
   * Sends an image to the hub and returns its reference.
   *
   * Reduced in the browser first: an organiser drops the 6000-pixel file the
   * sponsor sent, and the rooms need a logo.
   */
  async function upload(file: Blob): Promise<string> {
    const prepared = await prepareImage(file)
    if (prepared.base64.length > MAX_BASE64) {
      throw new ImageRefused('Image trop lourde, même réduite : 2 Mo au plus')
    }
    const { ref: reference, preview } = await session.client.rpc.boucle.uploadImage(prepared)
    previews.value = { ...previews.value, [reference]: preview }
    return reference
  }

  /** Where to show a reference from — the address itself while the hub has not said. */
  function previewOf(reference: string | null): string | null {
    if (reference == null) return null
    if (reference in previews.value) return previews.value[reference] ?? null
    return /^https?:\/\//.test(reference) ? reference : null
  }

  return {
    boucle,
    catalogue,
    openFeedbackProjectId,
    previews,
    load,
    loadPreviews,
    save,
    saveSections,
    revision,
    upload,
    previewOf,
  }
})

/**
 * Refused by the console before anything left.
 *
 * Its own class because the hub's refusals are already reported by the client's
 * error hook: the field only has to say the ones nobody else will.
 */
export class ImageRefused extends Error {}

type UploadType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml'
const UPLOAD_TYPES: string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']

/**
 * The file as it will travel: reduced when it can be, as is otherwise.
 *
 * - SVG is sent as is: it has no pixels to reduce.
 * - GIF too: redrawn on a canvas it would lose its animation.
 * - PNG stays PNG — a logo's transparency is what lets it sit in its circle.
 * - The rest becomes WebP, JPEG when the browser cannot encode WebP.
 *
 * A browser that cannot draw the image (no `createImageBitmap`, an odd format)
 * sends it as is: the hub says whether it takes it.
 */
export async function prepareImage(file: Blob): Promise<{ contentType: UploadType; base64: string }> {
  if (!UPLOAD_TYPES.includes(file.type)) {
    throw new ImageRefused('Format non pris en charge : PNG, JPEG, WebP, GIF ou SVG')
  }
  const type = file.type as UploadType
  const asIs = async () => ({ contentType: type, base64: await toBase64(file) })
  if (type === 'image/svg+xml' || type === 'image/gif') return asIs()

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return asIs()
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  // Small enough already: redrawing would only cost quality.
  if (scale === 1 && file.size < 1024 * 1024) return asIs()

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d')
  if (context == null) return asIs()
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

  const encode = (mime: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.86))
  if (type === 'image/png') {
    const png = await encode('image/png')
    return png == null ? asIs() : { contentType: 'image/png', base64: await toBase64(png) }
  }
  // A browser that cannot write WebP hands back a PNG instead, silently.
  const webp = await encode('image/webp')
  if (webp?.type === 'image/webp') return { contentType: 'image/webp', base64: await toBase64(webp) }
  const jpeg = await encode('image/jpeg')
  return jpeg == null ? asIs() : { contentType: 'image/jpeg', base64: await toBase64(jpeg) }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // By slices: `fromCharCode` over a whole megabyte overflows the call stack.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

const simplify = (text: string) =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * The catalogue's sponsor a placement names: by key, then by name.
 *
 * The same rule as `resolveSponsorRef` in `@conference-operator/program`, which
 * the rooms apply — restated here because the console does not depend on that
 * package. The two must agree: a logo the console calls "absent" and the room
 * finds, or the other way round, is the one confusion this badge exists to spare.
 */
export function findSponsor(placement: SponsorRef, sponsors: CatalogueSponsor[]): CatalogueSponsor | null {
  const wanted = simplify(placement.sponsor)
  return (
    sponsors.find((sponsor) => sponsor.key === placement.sponsor) ??
    (wanted === ''
      ? undefined
      : sponsors.find((sponsor) => simplify(sponsor.name) === wanted || simplify(sponsor.key) === wanted)) ??
    null
  )
}

/** Moves an item of a list by one place, in place. Out of bounds does nothing. */
export function move<T>(list: T[], index: number, delta: -1 | 1): void {
  const target = index + delta
  if (target < 0 || target >= list.length) return
  const [item] = list.splice(index, 1)
  list.splice(target, 0, item as T)
}
