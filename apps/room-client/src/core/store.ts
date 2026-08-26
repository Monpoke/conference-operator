import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { openDatabase } from '@cloudnord/db'
import {
  appliedCommand,
  clientSchema,
  journal,
  programCache,
  roomSettings,
} from '@cloudnord/db/client'
import { programSchema, type Program } from '@cloudnord/program'
import {
  eventIdentitySchema,
  IDENTITE_PAR_DEFAUT,
  roomConfigSchema,
  socialLinkSchema,
  vodSyncSchema,
  type EventIdentity,
  type RoomConfig,
  type SocialLink,
  type VodSync,
} from '@cloudnord/contract'

/**
 * Comptes relus du cache local.
 *
 * Tolérant : un JSON corrompu ou un schéma qui a bougé ne doit pas empêcher la
 * salle de démarrer pour une page décorative. La boucle sautera ses réseaux.
 */
function lireReseaux(brut: string | null): SocialLink[] {
  if (brut == null) return []
  try {
    const lu = socialLinkSchema.array().safeParse(JSON.parse(brut))
    return lu.success ? lu.data : []
  } catch {
    return []
  }
}

/**
 * Identité de l'événement relue du cache local.
 *
 * Le repli est neutre et non un nom d'événement : une machine jamais
 * synchronisée ne sait pas encore où elle est, et afficher le nom d'une autre
 * édition serait pire que ne rien affirmer. Le premier sync corrige.
 */
/**
 * Réglages de rapatriement relus du cache.
 *
 * `null` — cache absent, illisible, ou schéma qui a bougé — vaut « pas de
 * destination », donc rien ne part. C'est le repli qu'on veut : une salle qui
 * ne sait plus ce que le hub attend d'elle ne doit pas se mettre à téléverser
 * sur une supposition.
 */
function lireVod(brut: string | null): VodSync | null {
  if (brut == null) return null
  try {
    const lu = vodSyncSchema.safeParse(JSON.parse(brut))
    return lu.success ? lu.data : null
  } catch {
    return null
  }
}

function lireIdentite(brut: string | null): EventIdentity {
  if (brut == null) return IDENTITE_PAR_DEFAUT
  try {
    const lu = eventIdentitySchema.safeParse(JSON.parse(brut))
    return lu.success ? lu.data : IDENTITE_PAR_DEFAUT
  } catch {
    return IDENTITE_PAR_DEFAUT
  }
}

/**
 * Dossier des migrations locales.
 *
 * Deux emplacements selon le contexte : depuis les sources, il vit dans le
 * monorepo ; dans l'application installée, electron-builder le copie sous
 * `resources/`. Résoudre uniquement le premier produirait une application qui
 * démarre en développement et plante à l'installation — le genre de panne qu'on
 * découvre la veille.
 *
 * Le chemin du monorepo est **cherché**, pas compté. Ce fichier est chargé de
 * deux profondeurs différentes : `src/core/store.ts` sous `tsx`, et
 * `dist/main.cjs` une fois bundlé pour Electron, où tout le cœur applicatif est
 * aplati dans un seul fichier. Un nombre de `..` juste pour l'un est faux pour
 * l'autre — et c'est ce qui faisait planter le client Electron au démarrage,
 * sur un « Can't find meta/_journal.json » qui ne nomme ni le dossier cherché
 * ni la raison.
 */
function resolveMigrationsFolder(): string {
  const empaquete = process.resourcesPath
  if (empaquete != null) {
    const candidat = join(empaquete, 'migrations', 'client')
    if (existsSync(candidat)) return candidat
  }

  const visites: string[] = []
  let dossier = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidat = join(dossier, 'packages', 'db', 'migrations', 'client')
    visites.push(candidat)
    if (existsSync(candidat)) return candidat
    const parent = dirname(dossier)
    if (parent === dossier) break
    dossier = parent
  }

  // Dit franchement, et avec ce qui a été essayé : sans migrations, la base
  // locale n'existe pas, et sans base locale il n'y a pas de salle.
  throw new Error(
    [
      'Migrations locales introuvables : la salle ne peut pas ouvrir sa base.',
      "Dans l'application installée, elles voyagent sous resources/migrations/client",
      "(extraResources d'electron-builder) ; depuis les sources, dans packages/db/migrations/client.",
      'Cherchées ici :',
      ...visites.map((chemin) => `    ${chemin}`),
    ].join('\n'),
  )
}

/** Ligne unique : les réglages de la salle tiennent en un enregistrement. */
const SETTINGS_ID = 1

export interface RoomSettings {
  roomId: string | null
  token: string | null
  config: RoomConfig | null
  activeContentHash: string | null
  /** Comptes de l'événement, poussés par le hub. Mis en cache comme le programme. */
  socialLinks: SocialLink[]
  /**
   * Nom de l'événement, poussé par le hub. En cache pour la même raison.
   *
   * C'est ce qui titre les fenêtres et la boucle d'attente : l'écrire en dur
   * rendait une machine installée pour une édition incapable d'en servir une
   * autre sans réinstallation.
   */
  event: EventIdentity
  /** Destination et politique de rapatriement, poussées par le hub. */
  vod: VodSync | null
  nextSeq: number
  lastCommandSeq: number
  clockOffsetMs: number
}

/**
 * État local persistant de la machine.
 *
 * C'est le socle de l'autonomie : programme, réglages et progression du flux de
 * commandes survivent à un crash, à un redémarrage et à une journée entière sans
 * réseau. Une salle démarre à partir de cette base seule.
 */
export class LocalStore {
  private readonly orm: ReturnType<typeof drizzle<typeof clientSchema>>

  constructor(private readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const sqlite = openDatabase({ path })
    this.orm = drizzle(sqlite, { schema: clientSchema })
    try {
      migrate(this.orm, { migrationsFolder: resolveMigrationsFolder() })
    } catch (cause) {
      // Même situation que côté hub : une base créée avec un schéma antérieur.
      // La trace brute de Drizzle ne dit pas quoi faire ; ce message si.
      const detail = String((cause as { cause?: { message?: string } })?.cause?.message ?? '')
      if (/already exists/i.test(detail)) {
        throw new Error(
          [
            `Migration impossible : la base locale ${path} ne reconnaît pas les migrations.`,
            '',
            "Comme côté hub, la cause habituelle est une migration régénérée plutôt qu'ajoutée :",
            '    git checkout -- packages/db/migrations',
            '',
            'Cette base ne contient que du cache et une file de remontée. La supprimer est sans',
            "conséquence UNIQUEMENT si le compteur d'événements en attente est à zéro — sinon",
            'elle emporte des enregistrements et des marqueurs jamais remontés au hub.',
            `    rm -rf ${dirname(path)}`,
            '',
            'La machine devra être réappairée au prochain démarrage.',
            `Détail : ${detail}`,
          ].join('\n'),
          { cause },
        )
      }
      throw cause
    }
    this.ensureSettingsRow()
  }

  get db() {
    return this.orm
  }

  private ensureSettingsRow(): void {
    this.orm.insert(roomSettings).values({ id: SETTINGS_ID }).onConflictDoNothing().run()
  }

  settings(): RoomSettings {
    const row = this.orm.select().from(roomSettings).where(eq(roomSettings.id, SETTINGS_ID)).get()
    return {
      roomId: row?.roomId ?? null,
      token: row?.token ?? null,
      config: row?.configJson == null ? null : roomConfigSchema.parse(JSON.parse(row.configJson)),
      activeContentHash: row?.activeContentHash ?? null,
      // Réglage décoratif : un cache illisible ne doit pas empêcher la salle de
      // démarrer, la boucle sautera simplement sa page réseaux.
      socialLinks: lireReseaux(row?.socialLinksJson ?? null),
      event: lireIdentite(row?.eventIdentityJson ?? null),
      vod: lireVod(row?.vodJson ?? null),
      nextSeq: row?.nextSeq ?? 1,
      lastCommandSeq: row?.lastCommandSeq ?? 0,
      clockOffsetMs: row?.clockOffsetMs ?? 0,
    }
  }

  saveSettings(patch: Partial<Omit<RoomSettings, 'config'>> & { config?: RoomConfig }): void {
    const update: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (patch.roomId !== undefined) update.roomId = patch.roomId
    if (patch.token !== undefined) update.token = patch.token
    if (patch.config !== undefined) update.configJson = JSON.stringify(patch.config)
    if (patch.activeContentHash !== undefined) update.activeContentHash = patch.activeContentHash
    if (patch.socialLinks !== undefined) update.socialLinksJson = JSON.stringify(patch.socialLinks)
    if (patch.event !== undefined) update.eventIdentityJson = JSON.stringify(patch.event)
    if (patch.vod !== undefined) update.vodJson = patch.vod == null ? null : JSON.stringify(patch.vod)
    if (patch.lastCommandSeq !== undefined) update.lastCommandSeq = patch.lastCommandSeq
    if (patch.clockOffsetMs !== undefined) update.clockOffsetMs = patch.clockOffsetMs

    this.orm.update(roomSettings).set(update).where(eq(roomSettings.id, SETTINGS_ID)).run()
  }

  /**
   * Réserve le prochain `seq` sortant.
   *
   * Monotone et jamais réinitialisé, y compris après un redémarrage : c'est ce
   * qui permet au hub d'appliquer les événements dans l'ordre d'émission même
   * quand ils remontent des heures plus tard.
   */
  nextOutboundSeq(): number {
    const row = this.orm
      .update(roomSettings)
      .set({ nextSeq: sql`${roomSettings.nextSeq} + 1` })
      .where(eq(roomSettings.id, SETTINGS_ID))
      .returning({ nextSeq: roomSettings.nextSeq })
      .get()
    return row.nextSeq - 1
  }

  /** Enregistre un snapshot et le rend actif. */
  saveProgram(contentHash: string, program: Program): void {
    this.orm.transaction((tx) => {
      tx.update(programCache).set({ active: false }).run()
      tx.insert(programCache)
        .values({ contentHash, programJson: JSON.stringify(program), active: true })
        .onConflictDoUpdate({
          target: programCache.contentHash,
          set: { programJson: JSON.stringify(program), active: true, syncedAt: new Date().toISOString() },
        })
        .run()
      tx.update(roomSettings)
        .set({ activeContentHash: contentHash })
        .where(eq(roomSettings.id, SETTINGS_ID))
        .run()
    })
  }

  /**
   * Programme actif en cache.
   *
   * Renvoie `null` plutôt que de lever si le cache est corrompu : un écran de
   * repli vaut mieux qu'une application qui refuse de démarrer devant une salle.
   */
  activeProgram(): { contentHash: string; program: Program } | null {
    const row = this.orm.select().from(programCache).where(eq(programCache.active, true)).get()
    if (row == null) return null
    const parsed = programSchema.safeParse(JSON.parse(row.programJson))
    if (!parsed.success) return null
    return { contentHash: row.contentHash, program: parsed.data }
  }

  /** Une commande déjà appliquée ne doit pas l'être deux fois après reconnexion. */
  hasApplied(seq: number): boolean {
    return (
      this.orm.select().from(appliedCommand).where(eq(appliedCommand.seq, seq)).get() !== undefined
    )
  }

  markApplied(seq: number, type: string): void {
    this.orm.transaction((tx) => {
      tx.insert(appliedCommand).values({ seq, type }).onConflictDoNothing().run()
      tx.update(roomSettings)
        .set({ lastCommandSeq: sql`max(${roomSettings.lastCommandSeq}, ${seq})` })
        .where(eq(roomSettings.id, SETTINGS_ID))
        .run()
    })
  }

  /**
   * Journal local.
   *
   * C'est la seule trace exploitable quand le réseau a été absent toute la
   * journée : événements rejetés définitivement, incidents OBS, expirations.
   * Accepte une transaction pour être écrit dans le même atome que la
   * suppression qu'il justifie.
   */
  log(
    level: 'info' | 'warn' | 'error',
    message: string,
    context?: unknown,
    tx?: Pick<LocalStore['db'], 'insert'>,
  ): void {
    ;(tx ?? this.orm)
      .insert(journal)
      .values({
        level,
        message,
        contextJson: context == null ? null : JSON.stringify(context),
      })
      .run()
  }

  /** Entrées de journal les plus récentes, pour le panneau de diagnostic en régie. */
  recentLogs(limit = 50) {
    return this.orm
      .select()
      .from(journal)
      .orderBy(desc(journal.id))
      .limit(limit)
      .all()
  }

  close(): void {
    // `better-sqlite3` expose la connexion sous `$client` via Drizzle.
    ;(this.orm as unknown as { $client: { close: () => void } }).$client.close()
  }
}
