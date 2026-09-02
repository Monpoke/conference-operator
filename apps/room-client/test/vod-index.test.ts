import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import {
  ffprobeSonde,
  inspecterEnregistrement,
  lireSortieFfprobe,
  listerEnregistrements,
  nodeVodFs,
  outilDisponible,
  ouvrirExtrait,
  ouvrirFichier,
  poserVerdict,
  type SondageVod,
  type VodIndexDeps,
} from '../src/core/vod-index.js'
import type { Sidecar } from '../src/core/recording.js'

/**
 * Contrôle des rushes.
 *
 * Ce que ces tests protègent tient en une phrase : le soir de l'événement, la
 * salle est démontée et personne ne peut plus rien refaire. Un fichier vide ou
 * tronqué doit se voir pendant la journée, et se voir *comme tel* — un badge
 * vert sur un rush inexploitable est pire que pas de contrôle du tout.
 */
let racine: string

const SIDECAR: Sidecar = {
  sessionId: 'ses-1',
  title: 'HoneySwamp',
  speakers: [{ name: 'Steven', company: null }],
  roomId: 'track-1',
  trackTitle: 'track-1',
  category: null,
  startedAt: '2026-10-30T10:00:00.000Z',
  endedAt: '2026-10-30T10:45:00.000Z',
  durationMs: 45 * 60_000,
  markers: [{ label: 'démo', offsetMs: 60_000, at: '2026-10-30T10:01:00.000Z' }],
  videoFile: null,
}

/** Une heure plus tard : rien de ce qu'on écrit ici n'est « encore en écriture ». */
const PLUS_TARD = () => Date.now() + 3_600_000

/**
 * Les deux horloges, avancées ensemble.
 *
 * `now` date les verdicts, `maintenantReel` juge des `mtime` — et c'est la
 * seconde qui décide de la fenêtre d'écriture. Les fichiers de ces tests sont
 * écrits à l'instant : sans l'avancer elle aussi, tous seraient « encore en
 * écriture » et aucun contrôle ne dirait autre chose.
 */
function deps(options: Partial<VodIndexDeps> = {}): VodIndexDeps {
  return { root: racine, fs: nodeVodFs(), now: PLUS_TARD, maintenantReel: PLUS_TARD, ...options }
}

/**
 * Un rush de la taille annoncée, sans écrire un octet utile.
 *
 * Le débit moyen fait partie du verdict — un fichier de trois kilo-octets pour
 * quarante-cinq minutes est inexploitable, et le contrôle doit le dire. Il faut
 * donc une taille crédible : `truncate` la donne sans remplir le disque.
 */
function video(nom: string, octets = 2_700_000_000): string {
  const chemin = join(racine, nom)
  writeFileSync(chemin, '')
  truncateSync(chemin, octets)
  return chemin
}

function sidecar(nom: string, patch: Partial<Sidecar> = {}): void {
  writeFileSync(join(racine, nom), JSON.stringify({ ...SIDECAR, ...patch }, null, 2))
}

/** Sonde factice : ce que ffprobe aurait lu, sans ffprobe. */
function sonde(patch: Partial<SondageVod> = {}): (chemin: string) => Promise<SondageVod | null> {
  return async () => ({
    ouvert: true,
    durationMs: 45 * 60_000,
    video: { codec: 'h264', width: 1920, height: 1080, fps: 25 },
    audio: { codec: 'aac', channels: 2 },
    bitrateKbps: 8_000,
    ...patch,
  })
}

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'vod-'))
})

afterEach(() => {
  rmSync(racine, { recursive: true, force: true })
})

describe('liste des enregistrements', () => {
  it('apparie chaque vidéo à son sidecar, du plus récent au plus ancien', async () => {
    video('2026-10-30_track1_1000_honeyswamp.mkv')
    sidecar('2026-10-30_track1_1000_honeyswamp.json')
    video('2026-10-30_track1_1100_blind-ops.mkv')
    utimesSync(join(racine, '2026-10-30_track1_1000_honeyswamp.mkv'), new Date(1e9), new Date(1e9))

    const entrees = await listerEnregistrements(deps())

    expect(entrees.map((entree) => entree.file)).toEqual([
      '2026-10-30_track1_1100_blind-ops.mkv',
      '2026-10-30_track1_1000_honeyswamp.mkv',
    ])
    expect(entrees[1]!.sidecar?.title).toBe('HoneySwamp')
    // Le rush sans sidecar reste listé : c'est exactement celui qu'on cherche.
    expect(entrees[0]!.sidecar).toBeNull()
  })

  it('ignore ce qui n’est pas une vidéo', async () => {
    video('prise.mkv')
    writeFileSync(join(racine, 'notes.txt'), 'rien')
    writeFileSync(join(racine, 'prise.json'), '{}')

    const entrees = await listerEnregistrements(deps())

    expect(entrees.map((entree) => entree.file)).toEqual(['prise.mkv'])
  })

  it('descend dans un dossier daté', async () => {
    mkdirSync(join(racine, '2026-10-30'))
    writeFileSync(join(racine, '2026-10-30', 'prise.mp4'), 'x')

    const entrees = await listerEnregistrements(deps())

    expect(entrees.map((entree) => entree.file)).toEqual(['2026-10-30/prise.mp4'])
  })

  it('signale un fichier encore en écriture plutôt que de le juger', async () => {
    video('prise.mkv')

    const entree = (await listerEnregistrements(deps({ maintenantReel: () => Date.now() })))[0]!

    expect(entree.enEcriture).toBe(true)
  })

  it('juge la fenêtre d’écriture sur l’heure du poste, pas sur celle du hub', async () => {
    /*
     * Le défaut qui faisait passer une prise en cours pour un rush terminé.
     *
     * Les `mtime` viennent du système de fichiers, donc de l'heure de la
     * machine ; l'horloge de la salle, elle, est corrigée sur celle du hub. Sans
     * conséquence le jour J, où l'écart se compte en millisecondes — dévastateur
     * en développement, où le hub déroule une journée d'octobre depuis un poste
     * qui est en septembre : l'écart valait des semaines, la fenêtre n'était
     * jamais atteinte, et la régie proposait d'envoyer un fichier qu'OBS était
     * en train d'écrire.
     */
    video('prise.mkv')

    const entree = (
      await listerEnregistrements(
        deps({ now: () => Date.now() + 60 * 24 * 3_600_000, maintenantReel: () => Date.now() }),
      )
    )[0]!

    expect(entree.enEcriture).toBe(true)
  })

  it('ne juge pas une prise en cours, et ne l’accuse de rien', async () => {
    /*
     * Le contrôle continuait, et ce qu'il rendait était vrai mais trompeur : le
     * sidecar n'est écrit qu'à l'arrêt, donc « sidecar absent » est certain ; le
     * débit se calcule sur un fichier à moitié écrit. Trois motifs pour une
     * seule cause, dont le premier — le seul qui explique les deux autres — se
     * lisait au milieu des autres.
     */
    video('prise.mkv')
    const sonde = vi.fn(async () => null)

    const controle = await inspecterEnregistrement(
      deps({ maintenantReel: () => Date.now(), probe: sonde }),
      'prise.mkv',
    )

    expect(controle.status).toBe('suspect')
    expect(controle.reasons).toEqual(['prise en cours : à contrôler une fois l’enregistrement arrêté'])
    // Ni sonde : ouvrir le conteneur dans lequel OBS écrit coûte des
    // entrées-sorties sur le disque du master, pour une lecture fausse.
    expect(sonde).not.toHaveBeenCalled()
    expect(controle.probe).toBeNull()
  })

  it('ne casse pas sur un dossier absent', async () => {
    expect(await listerEnregistrements(deps({ root: join(racine, 'jamais') }))).toEqual([])
  })
})

describe('contrôle technique', () => {
  it('déclare illisible un fichier vide', async () => {
    writeFileSync(join(racine, 'prise.mkv'), '')

    const controle = await inspecterEnregistrement(deps({ probe: sonde() }), 'prise.mkv')

    expect(controle.status).toBe('illisible')
    expect(controle.reasons[0]).toContain('vide')
  })

  it('déclare exploitable une prise complète', async () => {
    video('prise.mkv')
    sidecar('prise.json')

    const controle = await inspecterEnregistrement(deps({ probe: sonde() }), 'prise.mkv')

    expect(controle.status).toBe('ok')
    expect(controle.probe?.video?.height).toBe(1080)
  })

  it('déclare illisible une prise sans piste audio', async () => {
    video('prise.mkv')
    sidecar('prise.json')

    const controle = await inspecterEnregistrement(
      deps({ probe: sonde({ audio: null }) }),
      'prise.mkv',
    )

    expect(controle.status).toBe('illisible')
    expect(controle.reasons.join(' ')).toContain('muette')
  })

  it('repère l’écart entre le chronomètre et le fichier', async () => {
    // Le symptôme d'un OBS tué en cours de route : quarante-cinq minutes
    // chronométrées en régie, douze minutes sur le disque.
    video('prise.mkv')
    sidecar('prise.json')

    const controle = await inspecterEnregistrement(
      deps({ probe: sonde({ durationMs: 12 * 60_000 }) }),
      'prise.mkv',
    )

    expect(controle.status).toBe('suspect')
    expect(controle.reasons.join(' ')).toContain('fin manquante')
  })

  it('rend le sidecar manquant visible sans crier à l’illisible', async () => {
    video('prise.mkv')

    const controle = await inspecterEnregistrement(deps({ probe: sonde() }), 'prise.mkv')

    expect(controle.status).toBe('suspect')
    expect(controle.reasons.join(' ')).toContain('sidecar absent')
  })

  it('dit que le contrôle est partiel quand ffprobe manque', async () => {
    video('prise.mkv')
    sidecar('prise.json')

    const controle = await inspecterEnregistrement(deps({ probe: async () => null }), 'prise.mkv')

    // Sans outil, une prise plausible reste « ok » — mais la page doit pouvoir
    // dire sur quoi ce « ok » repose vraiment.
    expect(controle.status).toBe('ok')
    expect(controle.reasons.join(' ')).toContain('sonde ffprobe indisponible')
    expect(controle.probe).toBeNull()
  })

  it('ne raconte pas piste par piste un fichier que ffprobe refuse', async () => {
    // Le cas du fichier qui n'est pas une vidéo du tout. « Aucune piste vidéo »
    // laisse croire à un conteneur valide amputé de son image, et envoie
    // chercher au mauvais endroit : les deux ne se réparent pas pareil.
    video('prise.mkv', 5_000)
    sidecar('prise.json')

    const controle = await inspecterEnregistrement(
      deps({ probe: async () => ({ ouvert: false, durationMs: null, video: null, audio: null, bitrateKbps: null }) }),
      'prise.mkv',
    )

    expect(controle.status).toBe('illisible')
    expect(controle.reasons).toEqual(['conteneur illisible : ffprobe ne reconnaît pas ce fichier'])
  })

  it('refuse de sortir du dossier des enregistrements', async () => {
    await expect(inspecterEnregistrement(deps(), '../../etc/passwd')).rejects.toThrow(/hors du dossier/)
  })
})

describe('verdict de l’opérateur', () => {
  it('survit à la fermeture de la modale et prime sur la sonde', async () => {
    video('prise.mkv')
    sidecar('prise.json')
    await inspecterEnregistrement(deps({ probe: sonde() }), 'prise.mkv')

    await poserVerdict(deps(), 'prise.mkv', 'illisible')
    const entree = (await listerEnregistrements(deps()))[0]!

    expect(entree.check?.status).toBe('illisible')
    expect(entree.check?.by).toBe('operateur')
    // Ce que la sonde avait lu reste sous les yeux : le verdict le complète.
    expect(entree.check?.probe?.video?.codec).toBe('h264')
  })

  it('s’efface, pour reprendre une fausse manœuvre', async () => {
    video('prise.mkv')
    await poserVerdict(deps(), 'prise.mkv', 'ok')

    expect(await poserVerdict(deps(), 'prise.mkv', null)).toBeNull()
    expect((await listerEnregistrements(deps()))[0]!.check).toBeNull()
  })

  it('ne perd pas les autres verdicts en enregistrant le sien', async () => {
    video('a.mkv')
    video('b.mkv')
    await poserVerdict(deps(), 'a.mkv', 'ok')
    await poserVerdict(deps(), 'b.mkv', 'illisible')

    const entrees = await listerEnregistrements(deps())

    expect(entrees.find((entree) => entree.file === 'a.mkv')?.check?.status).toBe('ok')
    expect(entrees.find((entree) => entree.file === 'b.mkv')?.check?.status).toBe('illisible')
  })
})

/**
 * Un verdict décrit **une prise**, pas un nom de fichier.
 *
 * Le format demandé à OBS est déterminant — date, salle, heure, titre — donc
 * rejouer la même conférence réécrit au même endroit. Le verdict de la
 * première prise s'affichait alors sur la seconde, avec la lecture ffprobe de
 * la première : « sidecar absent » sur un rush qui avait le sien.
 */
describe('péremption d’un verdict', () => {
  it('ne survit pas à la prise qu’il jugeait', async () => {
    video('prise.mkv')
    await inspecterEnregistrement(deps({ probe: sonde() }), 'prise.mkv')
    expect((await listerEnregistrements(deps()))[0]!.check?.status).toBe('suspect')

    // Deuxième prise du même talk : OBS réécrit sous le même nom.
    video('prise.mkv', 1_900_000_000)
    sidecar('prise.json')

    expect((await listerEnregistrements(deps()))[0]!.check).toBeNull()
  })

  it('ne survit pas non plus quand c’est l’opérateur qui l’a posé', async () => {
    video('prise.mkv')
    await poserVerdict(deps(), 'prise.mkv', 'ok')
    expect((await listerEnregistrements(deps()))[0]!.check?.status).toBe('ok')

    video('prise.mkv', 1_900_000_000)

    // « Relu en régie » ne doit pas se transmettre à la prise suivante : c'est
    // le seul verdict que personne ne songerait à remettre en cause.
    expect((await listerEnregistrements(deps()))[0]!.check).toBeNull()
  })

  it('tient tant que le fichier ne bouge pas', async () => {
    video('prise.mkv')
    sidecar('prise.json')
    await inspecterEnregistrement(deps({ probe: sonde() }), 'prise.mkv')

    expect((await listerEnregistrements(deps()))[0]!.check?.status).toBe('ok')
  })

  it('écarte un verdict écrit avant que l’empreinte existe', async () => {
    video('prise.mkv')
    // Le format d'avant : aucun moyen de savoir sur quoi il portait, donc la
    // ligne repasse « non vérifié » plutôt que d'afficher un jugement aveugle.
    writeFileSync(
      join(racine, '.controles-vod.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'prise.mkv': { status: 'suspect', at: '2026-10-30T08:00:00.000Z', by: 'auto', reasons: ['sidecar absent'], probe: null },
        },
      }),
    )

    expect((await listerEnregistrements(deps()))[0]!.check).toBeNull()
  })
})

describe('lecture de ffprobe', () => {
  it('retient les pistes, la durée et le débit', () => {
    const sondage = lireSortieFfprobe(
      JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
          { codec_type: 'audio', codec_name: 'aac', channels: 2 },
        ],
        format: { duration: '2700.5', bit_rate: '8000000' },
      }),
    )

    expect(sondage.durationMs).toBe(2_700_500)
    expect(sondage.video?.fps).toBe(29.97)
    expect(sondage.audio?.channels).toBe(2)
    expect(sondage.bitrateKbps).toBe(8000)
  })

  it('se rabat sur la durée de la piste vidéo', () => {
    // Les Matroska écrits en flux — ceux d'OBS — n'annoncent pas de durée de
    // conteneur : la lire là où elle est évite de les déclarer tous tronqués.
    const sondage = lireSortieFfprobe(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '600' }],
        format: {},
      }),
    )

    expect(sondage.durationMs).toBe(600_000)
    expect(sondage.audio).toBeNull()
  })

  it('rend null quand l’outil n’est pas installé', async () => {
    expect(await ffprobeSonde('ffprobe-qui-n-existe-pas')(join(racine, 'prise.mkv'))).toBeNull()
  })

  it('n’accuse pas le fichier quand c’est la sonde qui n’a pas répondu', async () => {
    /**
     * La confusion à éviter : un poste sans ffprobe — ou avec un ffprobe qu'on
     * n'a pas le droit d'exécuter — déclarerait « conteneur illisible » sur des
     * rushes parfaitement sains. C'est l'erreur de diagnostic que ce contrôle
     * est justement là pour éviter, et elle coûterait une journée de doute.
     */
    const faux = join(racine, 'ffprobe-non-executable')
    writeFileSync(faux, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    video('prise.mkv')
    sidecar('prise.json')

    expect(await ffprobeSonde(faux)(join(racine, 'prise.mkv'))).toBeNull()

    const controle = await inspecterEnregistrement(deps({ probe: ffprobeSonde(faux) }), 'prise.mkv')
    expect(controle.status).toBe('ok')
    expect(controle.reasons.join(' ')).toContain('sonde ffprobe indisponible')
    expect(controle.reasons.join(' ')).not.toContain('conteneur illisible')
  })
})

/**
 * Fabrique un vrai rush de trois secondes, image et son.
 *
 * Sans fichier réel, il n'y a rien à remballer : le seul test qui prouve qu'un
 * Matroska ressort en MP4 lisible par un navigateur a besoin d'un Matroska.
 * `null` quand la machine n'a pas de quoi le produire — le test s'efface alors,
 * plutôt que de rougir pour une raison qui n'a rien à voir avec le code.
 */
async function fabriquerRush(nom: string): Promise<string | null> {
  if (!(await outilDisponible('ffmpeg'))) return null
  const chemin = join(racine, nom)
  const fait = await new Promise<boolean>((termine) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
       '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
       '-c:a', 'aac', '-y', chemin],
      { timeout: 60_000 },
      (erreur) => termine(erreur == null),
    )
  })
  return fait ? chemin : null
}

/**
 * Referme un flux qu'on n'a pas lu.
 *
 * Sans ça, le fichier s'ouvre après le ménage de `afterEach` et l'`ENOENT`
 * remonte hors de tout test, où plus personne ne l'attend.
 */
function fermer(flux: { on: (e: string, h: () => void) => unknown; destroy: () => void }): void {
  flux.on('error', () => {})
  flux.destroy()
}

async function avaler(flux: NodeJS.ReadableStream): Promise<Buffer> {
  const morceaux: Buffer[] = []
  for await (const morceau of flux) morceaux.push(Buffer.from(morceau as Buffer))
  return Buffer.concat(morceaux)
}

describe('lecture d’un rush', () => {
  it('sert le fichier entier quand rien n’est demandé', async () => {
    video('prise.mkv', 5_000)

    const flux = (await ouvrirFichier(deps(), 'prise.mkv'))!

    expect(flux.taille).toBe(5_000)
    expect([flux.debut, flux.fin]).toEqual([0, 4_999])
    expect(flux.type).toBe('video/x-matroska')
    fermer(flux.flux)
  })

  it('sert la tranche demandée', async () => {
    // Ce qui rend un fichier de trois gigaoctets navigable : sans les tranches,
    // un lecteur télécharge tout avant la première image.
    video('prise.mp4', 5_000)

    const flux = (await ouvrirFichier(deps(), 'prise.mp4', 'bytes=1000-1999'))!

    expect([flux.debut, flux.fin]).toEqual([1_000, 1_999])
    expect(flux.type).toBe('video/mp4')
    expect((await avaler(flux.flux)).length).toBe(1_000)
  })

  it('sert la fin du fichier, où les lecteurs cherchent l’index', async () => {
    video('prise.mkv', 5_000)

    const flux = (await ouvrirFichier(deps(), 'prise.mkv', 'bytes=-500'))!

    expect([flux.debut, flux.fin]).toEqual([4_500, 4_999])
    fermer(flux.flux)
  })

  it('rend null sur un fichier absent, et refuse de sortir du dossier', async () => {
    expect(await ouvrirFichier(deps(), 'jamais.mkv')).toBeNull()
    await expect(ouvrirFichier(deps(), '../../etc/passwd')).rejects.toThrow(/hors du dossier/)
  })
})

describe('aperçu', () => {
  it('dit non plutôt que d’ouvrir un lecteur qui ne démarrera jamais', async () => {
    video('prise.mkv')

    expect(
      await ouvrirExtrait(deps(), 'prise.mkv', { commande: 'ffmpeg-qui-n-existe-pas' }),
    ).toBeNull()
  })

  it('remballe un Matroska en MP4 sans toucher au fichier', async () => {
    const chemin = await fabriquerRush('essai.mkv')
    if (chemin == null) return

    const extrait = (await ouvrirExtrait(deps({ probe: ffprobeSonde() }), 'essai.mkv', {
      atMs: 0,
      dureeMs: 5_000,
    }))!
    const octets = await avaler(extrait.flux)
    extrait.arreter()

    // `ftyp` en tête : c'est un MP4, et c'est tout ce qu'un navigateur demande
    // pour afficher une image d'un conteneur qu'il ne sait pas ouvrir.
    expect(octets.length).toBeGreaterThan(1_000)
    expect(octets.subarray(0, 12).toString('latin1')).toContain('ftyp')
    // Le rush d'origine est intact : on n'écrit jamais sur ce qui a été capté.
    expect((await listerEnregistrements(deps()))[0]!.file).toBe('essai.mkv')
  }, 90_000)
})
