import { randomBytes } from 'node:crypto'
import type { YoutubeEnvoi, YoutubeStatus } from '@conference-operator/contract'
import { hubSetting, youtubeEnvoi } from '@conference-operator/db/hub'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { HubDatabase } from '../db.js'
import type { SecretBox } from '../secrets.js'

const SETTING_KEY = 'youtube'
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos'
// `youtube` and not `youtube.upload` alone: changing a video's visibility asks for it.
const SCOPES = 'https://www.googleapis.com/auth/youtube'
const CONSENT_TTL_MS = 10 * 60_000
const PROGRESS_EVERY_BYTES = 16 * 1024 * 1024

const storedSchema = z.object({
  clientId: z.string().nullable().default(null),
  clientSecretSealed: z.string().nullable().default(null),
  refreshTokenSealed: z.string().nullable().default(null),
  channel: z.string().nullable().default(null),
  playlist: z.object({ id: z.string(), title: z.string(), publique: z.boolean(), videoIds: z.array(z.string()) }).nullable().default(null),
})
type Stored = z.infer<typeof storedSchema>

/** What YouTube is told about a video. */
export interface YoutubeMetadata {
  title: string
  description: string
}

export interface YoutubeOptions {
  db: HubDatabase
  box: SecretBox
  publicUrl: string
  /** Signed address of the edited video, and what to call it. `null`: no longer sendable. */
  source: (jobId: string) => { url: string; metadata: YoutubeMetadata } | null
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (message: string, cause: unknown) => void
}

/** YouTube's rules: 100 characters, and no angle brackets. */
export function youtubeTitle(title: string): string {
  return title.replace(/[<>]/g, '').trim().slice(0, 100) || 'Vidéo'
}

/**
 * Sends edited videos to one YouTube channel, one at a time, from the storage to
 * YouTube without touching the disk.
 *
 * Always as **private**: publishing stays a gesture made in YouTube Studio, after
 * the speaker's agreement and a look at the result. An interrupted send starts
 * over: a restart puts it back in the queue.
 */
export class YoutubeService {
  readonly #options: YoutubeOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #consents = new Map<string, number>()
  #running = false

  constructor(options: YoutubeOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    options.db.update(youtubeEnvoi).set({ state: 'attente', octets: 0 }).where(eq(youtubeEnvoi.state, 'en-cours')).run()
  }

  #stored(): Stored {
    const row = this.#options.db.select().from(hubSetting).where(eq(hubSetting.key, SETTING_KEY)).get()
    return storedSchema.parse(row == null ? {} : JSON.parse(row.valueJson))
  }

  #store(patch: Partial<Stored>): void {
    const valueJson = JSON.stringify({ ...this.#stored(), ...patch })
    const updatedAt = new Date(this.#now()).toISOString()
    this.#options.db
      .insert(hubSetting)
      .values({ key: SETTING_KEY, valueJson, updatedAt })
      .onConflictDoUpdate({ target: hubSetting.key, set: { valueJson, updatedAt } })
      .run()
  }

  get redirectUri(): string {
    return `${this.#options.publicUrl.replace(/\/+$/, '')}/youtube/retour`
  }

  status(): YoutubeStatus {
    const stored = this.#stored()
    return {
      clientId: stored.clientId,
      hasSecret: stored.clientSecretSealed != null,
      connected: stored.refreshTokenSealed != null,
      channel: stored.channel,
      playlist: stored.playlist == null ? null : { id: stored.playlist.id, title: stored.playlist.title, publique: stored.playlist.publique, videos: stored.playlist.videoIds.length },
      redirectUri: this.redirectUri,
    }
  }

  setClient(clientId: string, clientSecret: string): YoutubeStatus {
    // Another Google project: the channel's token belonged to the previous one.
    this.#store({ clientId, clientSecretSealed: this.#options.box.seal(clientSecret), refreshTokenSealed: null, channel: null, playlist: null })
    return this.status()
  }

  disconnect(): YoutubeStatus {
    this.#store({ refreshTokenSealed: null, channel: null, playlist: null })
    return this.status()
  }

  /** Google's consent page. The `state` is what lets the way back in: it is that page's only guard. */
  consentUrl(): string {
    const { clientId } = this.#stored()
    if (clientId == null) throw new Error('Identifiants Google non renseignés')
    const state = randomBytes(24).toString('base64url')
    this.#consents.set(state, this.#now() + CONSENT_TTL_MS)
    const url = new URL(AUTH)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString()
    return url.toString()
  }

  /** The way back from Google. */
  async complete(state: string, code: string): Promise<void> {
    const expires = this.#consents.get(state)
    this.#consents.delete(state)
    if (expires == null || expires < this.#now()) throw new Error('Demande expirée : recommencez depuis les réglages')
    const answer = await this.#token({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri })
    if (answer.refresh_token == null) throw new Error('Google n’a pas donné de jeton durable')
    this.#store({
      refreshTokenSealed: this.#options.box.seal(answer.refresh_token),
      channel: await this.#channelName(answer.access_token),
    })
  }

  /** Unreadable once the hub's secret has changed: the link is then made again from the settings. */
  #open(sealed: string): string {
    const value = this.#options.box.open(sealed)
    if (value == null) throw new Error('Secret Google illisible : renseignez à nouveau les identifiants')
    return value
  }

  async #token(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string }> {
    const { clientId, clientSecretSealed } = this.#stored()
    if (clientId == null || clientSecretSealed == null) throw new Error('Identifiants Google non renseignés')
    const response = await this.#fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: this.#open(clientSecretSealed) }),
    })
    if (!response.ok) throw new Error(`Google a refusé l’autorisation (${response.status})`)
    return z.object({ access_token: z.string(), refresh_token: z.string().optional() }).parse(await response.json())
  }

  async #channelName(accessToken: string): Promise<string | null> {
    const response = await this.#fetch(`${API}/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return null
    const body = (await response.json()) as { items?: { snippet?: { title?: string } }[] }
    return body.items?.[0]?.snippet?.title ?? null
  }

  envois(): YoutubeEnvoi[] {
    return this.#options.db
      .select()
      .from(youtubeEnvoi)
      .orderBy(desc(youtubeEnvoi.updatedAt))
      .all()
      .map((row) => ({ ...row, state: row.state as YoutubeEnvoi['state'], visibilite: row.visibilite as YoutubeEnvoi['visibilite'] }))
  }

  /** Queues these videos. One waiting or being sent stays as it is; one that failed or was sent goes again. */
  enqueue(jobIds: readonly string[]): void {
    const current = new Map(this.envois().map((envoi) => [envoi.jobId, envoi.state]))
    const updatedAt = new Date(this.#now()).toISOString()
    for (const jobId of jobIds) {
      const state = current.get(jobId)
      if (state === 'attente' || state === 'en-cours') continue
      const row = { state: 'attente', videoId: null, visibilite: 'private', octets: 0, taille: null, erreur: null, updatedAt }
      this.#options.db.insert(youtubeEnvoi).values({ jobId, ...row }).onConflictDoUpdate({ target: youtubeEnvoi.jobId, set: row }).run()
    }
    void this.tick()
  }

  /** Publishes a video already on the channel, or makes it private again. */
  async setVisibilite(jobId: string, publique: boolean): Promise<void> {
    const envoi = this.envois().find((candidate) => candidate.jobId === jobId)
    if (envoi?.videoId == null) throw new Error('Cette vidéo n’est pas encore sur YouTube')
    const { refreshTokenSealed } = this.#stored()
    if (refreshTokenSealed == null) throw new Error('Chaîne déconnectée')
    const { access_token: accessToken } = await this.#token({ grant_type: 'refresh_token', refresh_token: this.#open(refreshTokenSealed) })
    const visibilite = publique ? 'public' : 'private'
    const response = await this.#fetch(`${API}/videos?part=status`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: envoi.videoId, status: { privacyStatus: visibilite, selfDeclaredMadeForKids: false } }),
    })
    if (!response.ok) throw new Error(await youtubeError(response))
    this.#update(jobId, { visibilite })
  }

  /**
   * The channel's playlist: made once, then updated. A video already in it is not
   * added again, and each addition is kept as it goes: a failure halfway resumes there.
   */
  async syncPlaylist(title: string, publique: boolean, videoIds: readonly string[]): Promise<void> {
    const { refreshTokenSealed, playlist: known } = this.#stored()
    if (refreshTokenSealed == null) throw new Error('Chaîne déconnectée')
    const { access_token: accessToken } = await this.#token({ grant_type: 'refresh_token', refresh_token: this.#open(refreshTokenSealed) })
    const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
    const body = { snippet: { title: youtubeTitle(title) }, status: { privacyStatus: publique ? 'public' : 'private' } }

    let current = known
    if (current != null) {
      const updated = await this.#fetch(`${API}/playlists?part=snippet,status`, { method: 'PUT', headers, body: JSON.stringify({ id: current.id, ...body }) })
      // Deleted on YouTube since: made again below.
      if (updated.status === 404) current = null
      else if (!updated.ok) throw new Error(await youtubeError(updated))
    }
    if (current == null) {
      const created = await this.#fetch(`${API}/playlists?part=snippet,status`, { method: 'POST', headers, body: JSON.stringify(body) })
      if (!created.ok) throw new Error(await youtubeError(created))
      current = { id: z.object({ id: z.string() }).parse(await created.json()).id, title, publique, videoIds: [] }
    }
    const playlist = { ...current, title, publique }
    this.#store({ playlist })
    for (const videoId of videoIds) {
      if (playlist.videoIds.includes(videoId)) continue
      const added = await this.#fetch(`${API}/playlistItems?part=snippet`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ snippet: { playlistId: playlist.id, resourceId: { kind: 'youtube#video', videoId } } }),
      })
      if (!added.ok) throw new Error(await youtubeError(added))
      playlist.videoIds = [...playlist.videoIds, videoId]
      this.#store({ playlist })
    }
  }

  /** Sends what waits, one at a time. Resolved once the queue is empty. */
  async tick(): Promise<void> {
    if (this.#running || this.#stored().refreshTokenSealed == null) return
    this.#running = true
    try {
      for (;;) {
        const next = this.envois().filter((envoi) => envoi.state === 'attente').at(-1)
        if (next == null) return
        await this.#send(next.jobId)
      }
    } finally {
      this.#running = false
    }
  }

  #update(jobId: string, patch: Partial<typeof youtubeEnvoi.$inferInsert>): void {
    this.#options.db.update(youtubeEnvoi).set({ ...patch, updatedAt: new Date(this.#now()).toISOString() }).where(eq(youtubeEnvoi.jobId, jobId)).run()
  }

  async #send(jobId: string): Promise<void> {
    this.#update(jobId, { state: 'en-cours', octets: 0, erreur: null })
    try {
      const videoId = await this.#upload(jobId)
      this.#update(jobId, { state: 'termine', videoId })
    } catch (cause) {
      this.#options.log?.('envoi YouTube en échec', cause)
      this.#update(jobId, { state: 'echoue', erreur: (cause as Error).message.slice(0, 300) })
    }
  }

  async #upload(jobId: string): Promise<string> {
    const source = this.#options.source(jobId)
    if (source == null) throw new Error('Cette vidéo n’est plus disponible, ou sa diffusion a été refusée')
    const { refreshTokenSealed } = this.#stored()
    if (refreshTokenSealed == null) throw new Error('Chaîne déconnectée')
    const { access_token: accessToken } = await this.#token({ grant_type: 'refresh_token', refresh_token: this.#open(refreshTokenSealed) })

    const video = await this.#fetch(source.url)
    const size = Number(video.headers.get('content-length'))
    if (!video.ok || video.body == null || !Number.isFinite(size) || size === 0) throw new Error(`Stockage : la vidéo n’a pas pu être lue (${video.status})`)
    this.#update(jobId, { taille: size })

    const opened = await this.#fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=utf-8',
        'x-upload-content-type': 'video/mp4',
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify({
        snippet: { title: youtubeTitle(source.metadata.title), description: source.metadata.description.replace(/[<>]/g, '').slice(0, 4900), categoryId: '28' },
        status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
      }),
    })
    const location = opened.headers.get('location')
    if (!opened.ok || location == null) {
      await video.body.cancel()
      throw new Error(await youtubeError(opened))
    }

    let sent = 0
    let reported = 0
    const counted = video.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        sent += chunk.byteLength
        if (sent - reported >= PROGRESS_EVERY_BYTES) {
          reported = sent
          this.#update(jobId, { octets: sent })
        }
        controller.enqueue(chunk)
      },
    }))
    const finished = await this.#fetch(location, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      body: counted,
      duplex: 'half',
    } as RequestInit)
    if (!finished.ok) throw new Error(await youtubeError(finished))
    const { id } = z.object({ id: z.string() }).parse(await finished.json())
    this.#update(jobId, { octets: size })
    return id
  }
}

async function youtubeError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null
  const reason = body?.error?.errors?.[0]?.reason
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') return 'Quota YouTube atteint : relancez demain'
  return `YouTube a répondu ${response.status}${body?.error?.message == null ? '' : ` : ${body.error.message}`}`
}
