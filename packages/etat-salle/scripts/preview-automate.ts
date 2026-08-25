/**
 * Écrit le banc d'essai de l'automate, avec un vrai programme dedans.
 *
 * Par défaut celui de l'export Cloud Nord 2026 qui sert aussi aux tests : les
 * horaires qu'on y déroule sont ceux du jour J, pauses partagées comprises.
 *
 *     pnpm --filter @cloudnord/etat-salle preview [dossier] [chemin/export.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySharedBreaks, normalizeProgram, sessionsForRoom } from '@cloudnord/program'
import { renderAutomatePage, type SalleApercu } from '../src/page-automate.js'

const outDir = resolve(process.argv[2] ?? './preview')
const source =
  process.argv[3] ??
  fileURLToPath(new URL('../../program/test/fixtures/cloudnord-2026.json', import.meta.url))

/**
 * Pauses partagées appliquées, comme le hub les sert.
 *
 * Sans elles, une salle sans déjeuner au programme resterait « hors créneau »
 * pendant que les autres sont en pause — et on chercherait le défaut dans
 * l'automate alors qu'il est dans le programme qu'on lui donne.
 */
const program = applySharedBreaks(normalizeProgram(JSON.parse(readFileSync(source, 'utf8'))))

const salles: SalleApercu[] = program.rooms.map((salle) => ({
  id: salle.id,
  name: salle.name,
  creneaux: sessionsForRoom(program, salle.id).map((session) => ({
    id: session.id,
    title: session.title,
    kind: session.kind,
    startsAt: session.startsAt,
    startsAtMs: session.startsAtMs,
    endsAt: session.endsAt,
    endsAtMs: session.endsAtMs,
    durationMinutes: session.durationMinutes,
  })),
}))

if (salles.length === 0) throw new Error(`Aucune salle dans ${source}`)

const html = renderAutomatePage({
  salles,
  timezone: program.timezone,
  evenement: program.event.name,
  // Une demi-heure avant le premier créneau : la page s'ouvre sur « hors
  // créneau », et on voit la journée démarrer plutôt que de la prendre en route.
  depart: (salles[0]!.creneaux[0]?.startsAtMs ?? Date.now()) - 30 * 60_000,
})

mkdirSync(outDir, { recursive: true })
const chemin = join(outDir, 'automate.html')
writeFileSync(chemin, html)
console.log(`écrit ${chemin}`)
console.log(`  ${salles.length} salles · ${program.sessions.length} créneaux · ${program.timezone}`)
