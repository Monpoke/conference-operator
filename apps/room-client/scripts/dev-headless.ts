/**
 * Lance une salle **sans Electron**.
 *
 * Toute la logique du client vit dans `core/` et ne dépend pas d'Electron :
 * on peut donc démarrer une salle complète et ouvrir ses pages dans un
 * navigateur. Utile pour développer sur une machine sans interface graphique
 * — WSL, conteneur, serveur distant — et pour observer la chaîne sans monter
 * une régie physique.
 *
 *   HUB_ORIGIN=http://localhost:8787 pnpm dev:headless
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { RoomApp } from '../src/core/room-app.js'
import { createMockObsTransport } from '../src/core/obs-mock.js'
import { formaterLigneJournal } from '../src/core/journal-console.js'

const hubOrigin = process.env.HUB_ORIGIN ?? 'http://localhost:8787'
const dataDir = resolve(process.env.DATA_DIR ?? './.donnees-locales')
const port = Number(process.env.DISPLAY_PORT ?? 7788)
const obsReel = process.env.OBS_REEL === '1'
/**
 * Heure simulée locale, pour développer **sans hub**.
 *
 * Dès qu'un hub répond, c'est son heure qui l'emporte : la salle cale son
 * offset sur `serverTime` à chaque synchronisation. Pour simuler une journée
 * d'événement, régler `SIMULATED_TIME` sur le hub plutôt qu'ici — sinon les
 * deux horloges divergent et tout ce qui les compare se met à mentir.
 */
const heureSimulee = process.env.HEURE_SIMULEE ?? null

mkdirSync(dataDir, { recursive: true })

/** Identité de la machine, conservée entre deux lancements. */
const cheminClientId = join(dataDir, 'client-id')
const clientId = existsSync(cheminClientId)
  ? readFileSync(cheminClientId, 'utf8').trim()
  : (() => {
      const nouveau = ulid()
      writeFileSync(cheminClientId, nouveau)
      return nouveau
    })()

/** Jeton en clair : c'est un environnement de développement, et on le dit. */
const cheminJeton = join(dataDir, 'jeton')

/**
 * Horloge de la salle. En heure simulée, elle avance au rythme réel depuis
 * l'instant demandé : le compte à rebours et la timeline restent vivants.
 */
const demarrage = Date.now()
const cibleMs = heureSimulee == null ? null : Date.parse(heureSimulee)
if (heureSimulee != null && Number.isNaN(cibleMs)) {
  console.error(`HEURE_SIMULEE illisible : ${heureSimulee}`)
  process.exit(1)
}
const maintenant = cibleMs == null ? undefined : () => cibleMs + (Date.now() - demarrage)

const room = new RoomApp({
  dataDir,
  now: maintenant,
  // `ROOM_ID` court-circuite l'écran de choix, pour un poste provisionné.
  roomId: process.env.ROOM_ID,
  hubOrigin,
  clientId,
  displayPort: port,
  readToken: () => (existsSync(cheminJeton) ? readFileSync(cheminJeton, 'utf8').trim() : null),
  writeToken: (jeton) => writeFileSync(cheminJeton, jeton),
  obsTransportFactory: obsReel
    ? undefined
    : (instance) =>
        createMockObsTransport({
          instance,
          recordingDir: join(dataDir, 'enregistrements'),
          onLog: (message) => console.log(formaterLigneJournal('info', message)),
        }),
  onLog: (niveau, message, contexte) => console.log(formaterLigneJournal(niveau, message, contexte)),
  onPairingCode: (code) => {
    console.log('')
    console.log('  ┌─────────────────────────────────────────────┐')
    console.log(`  │  Code d'appairage :  ${code.user_code.padEnd(22)}│`)
    console.log('  └─────────────────────────────────────────────┘')
    console.log(`  À saisir dans la console : ${hubOrigin}/admin`)
    console.log('')
  },
})

const local = await room.startDisplay()

console.log('')
console.log(`  Salle démarrée — machine ${clientId}`)
console.log(`  Régie       ${local}/regie`)
console.log(`  Projection  ${local}/display/projector`)
console.log(`  Habillage   ${local}/display/overlay`)
console.log(`  OBS         ${obsReel ? 'réel (obs-websocket)' : 'simulé'}`)
console.log('')

if (cibleMs != null) {
  room.runtime.refreshSessions()
  console.log(`  Heure simulée localement : ${new Date(cibleMs).toISOString()}`)
  console.log("  (l'heure du hub l'emportera dès la connexion)")
}

// Surveillance du hub : un hub absent au démarrage ne condamne pas la salle,
// elle le rejoindra dès qu'il répondra.
room.startSupervision()

const jeton = await room.ensurePaired()
if (jeton == null) {
  console.log('  Hub injoignable — la salle tourne sur son cache local et réessaiera.')
} else {
  await room.connectHub(jeton)
  await room.connectObs()
  room.runtime.refreshSessions()
  console.log('  Hub connecté, OBS connecté.')
  const etat = room.runtime.state()
  if (etat.simulatedClock) {
    console.log('  Horloge du hub : SIMULÉE')
  }
  console.log(`  Talk en cours : ${etat.currentSession?.title ?? 'aucun'}`)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void room.close().then(() => process.exit(0))
  })
}
