import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOD_POLICY, type SignedPart, type UploadPlan } from '@cloudnord/contract'
import { LocalStore } from '../src/core/store.js'
import {
  Televersements,
  type CandidatVod,
  type HubVod,
  type TeleversementDeps,
} from '../src/core/televersement.js'

/**
 * Le rapatriement d'un rush doit **finir**.
 *
 * C'est toute la question. Un fichier de trois gigaoctets sur le réseau d'un
 * événement sera coupé — pas peut-être, sûrement : quelqu'un débranche un
 * switch, le Wi-Fi sature à la pause, la machine redémarre pour une mise à jour
 * Windows lancée au mauvais moment. Un téléverseur qui recommence à chaque
 * coupure ne termine jamais, et personne ne s'en aperçoit avant de chercher la
 * VOD.
 *
 * D'où ce que ces tests tiennent : la reprise part de la part suivante, on ne
 * monte qu'un fichier à la fois, les tranches sont exactes à l'octet, et le
 * sidecar ne part jamais devant son rush.
 */

const PART = 8 * 1024 * 1024
const TAILLE = PART * 3 + 1234

/** Un hub qui accepte tout, et note ce qu'on lui a demandé. */
function fauxHub(options: { recues?: number[] } = {}) {
  const journal = {
    begin: [] as { file: string; kind: string }[],
    parts: [] as number[],
    progress: [] as { numero: number; etag: string }[],
    complete: [] as string[],
    abort: [] as string[],
  }
  const hub: HubVod = {
    async begin(entree): Promise<UploadPlan> {
      journal.begin.push({ file: entree.file, kind: entree.kind })
      if (entree.kind === 'sidecar') {
        return {
          mode: 'direct',
          uploadId: `up-${entree.file}`,
          url: `https://s3.test/${entree.file}`,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }
      }
      return {
        mode: 'multipart',
        uploadId: `up-${entree.file}`,
        taillePartOctets: PART,
        parts: Math.ceil(entree.sizeBytes / PART),
        recues: options.recues ?? [],
      }
    },
    async parts(_uploadId, numeros): Promise<SignedPart[]> {
      journal.parts.push(...numeros)
      return numeros.map((numero) => ({
        numero,
        url: `https://s3.test/part/${numero}`,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }))
    },
    async progress(entree) {
      journal.progress.push({ numero: entree.numero, etag: entree.etag })
    },
    async complete(uploadId) {
      journal.complete.push(uploadId)
    },
    async abort(uploadId) {
      journal.abort.push(uploadId)
    },
  }
  return { hub, journal }
}

/**
 * Demande, puis attend la passe que la demande a lancée.
 *
 * En vrai, `demander()` rend la main tout de suite : un clic sur « Téléverser »
 * ne doit pas bloquer la régie pendant trois gigaoctets. `passe()` rejoint le
 * travail déjà en vol, ce qui donne ici l'attente qu'il nous faut.
 */
async function demanderEtAttendre(m: Montage, file: string | null): Promise<void> {
  await m.televersements.demander(file)
  await m.televersements.passe()
}

const UN_RUSH: CandidatVod = {
  file: '2026-10-30_track1_1100_honeyswamp.mkv',
  sizeBytes: TAILLE,
  beingWritten: false,
  sessionId: 'sess-1',
  sidecar: { file: '2026-10-30_track1_1100_honeyswamp.json', sizeBytes: 900 },
}

interface Montage {
  televersements: Televersements
  tranches: { file: string; debut: number; fin: number }[]
  envois: { url: string; octets: number }[]
  attentes: number[]
}

function monter(
  hub: HubVod | null,
  patch: Partial<TeleversementDeps> = {},
  candidats: CandidatVod[] = [UN_RUSH],
): Montage {
  const tranches: { file: string; debut: number; fin: number }[] = []
  const envois: { url: string; octets: number }[] = []
  const attentes: number[] = []
  const televersements = new Televersements({
    store: new LocalStore(':memory:'),
    candidats: async () => candidats,
    hub: () => hub,
    politique: () => ({ ...DEFAULT_VOD_POLICY, actif: true }),
    charge: () => ({ cpu: 0.1, cores: 8, windowMs: 2000, memory: null }),
    enregistre: () => false,
    conferenceEnCours: () => false,
    msAvantProchaine: () => null,
    cheminDe: (file) => `/tmp/${file}`,
    lireTranche: async (file, debut, fin) => {
      tranches.push({ file, debut, fin })
      return Buffer.alloc(fin - debut)
    },
    envoyerPart: async (url, corps) => {
      envois.push({ url, octets: corps.byteLength })
      return `"etag-${envois.length}"`
    },
    attendre: async (ms) => {
      attentes.push(ms)
    },
    ...patch,
  })
  return { televersements, tranches, envois, attentes }
}

describe('monter un rush', () => {
  it('découpe le fichier en parts exactes, dernière comprise', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub)
    await demanderEtAttendre(m, UN_RUSH.file)

    expect(journal.parts).toEqual([1, 2, 3, 4])
    // Trois parts pleines et un reste. Se tromper d'un octet sur la dernière
    // produit un fichier que le stockage accepte et que personne ne relit avant
    // le editing : c'est la borne qu'il faut tenir.
    expect(m.tranches.filter((t) => t.file === UN_RUSH.file)).toEqual([
      { file: UN_RUSH.file, debut: 0, fin: PART },
      { file: UN_RUSH.file, debut: PART, fin: PART * 2 },
      { file: UN_RUSH.file, debut: PART * 2, fin: PART * 3 },
      { file: UN_RUSH.file, debut: PART * 3, fin: TAILLE },
    ])
    // Le dernier envoi du rush porte le reste, pas une part pleine.
    expect(m.envois.filter((e) => e.url.includes('/part/')).at(-1)?.octets).toBe(1234)
  })

  it('acquitte chaque part avec son ETag, sans lequel rien ne se recompose', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub)
    await demanderEtAttendre(m, UN_RUSH.file)

    expect(journal.progress.map((p) => p.numero)).toEqual([1, 2, 3, 4])
    expect(journal.progress.every((p) => p.etag.startsWith('"etag-'))).toBe(true)
    expect(journal.complete).toContain(`up-${UN_RUSH.file}`)
  })

  it('reprend à la part suivante après un redémarrage', async () => {
    // Le cœur du sujet : la machine est repartie alors que deux parts étaient
    // déjà chez le stockage. Les rejouer coûterait seize mégaoctets et, sur un
    // rush de trois gigaoctets, une salle qui redémarre deux fois ne finirait
    // jamais.
    const { hub, journal } = fauxHub({ recues: [1, 2] })
    const m = monter(hub)
    await demanderEtAttendre(m, UN_RUSH.file)

    expect(journal.parts).toEqual([3, 4])
    expect(m.tranches.filter((t) => t.file === UN_RUSH.file).map((t) => t.debut)).toEqual([
      PART * 2,
      PART * 3,
    ])
  })

  it('envoie le sidecar après le rush, jamais devant', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub)
    await demanderEtAttendre(m, UN_RUSH.file)

    // Un sidecar arrivé seul décrirait une conférence dont la vidéo n'est pas
    // là : le editing croirait le rush perdu.
    expect(journal.begin.map((b) => b.kind)).toEqual(['rush', 'sidecar'])
    expect(journal.begin.at(-1)?.file).toBe(UN_RUSH.sidecar?.file)
    expect(m.envois.at(-1)?.url).toContain('.json')
  })

  it('ne monte pas le sidecar quand le rush a échoué', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub, {
      envoyerPart: async () => {
        throw new Error('le stockage a refusé la part (HTTP 503)')
      },
    })
    await demanderEtAttendre(m, UN_RUSH.file)

    expect(journal.begin.map((b) => b.kind)).toEqual(['rush'])
    expect(m.televersements.vue().entries[0]?.error).toContain('503')
  })

  it('écarte une prise encore en cours d\'écriture', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub, {}, [{ ...UN_RUSH, beingWritten: true }])
    await demanderEtAttendre(m, null)

    // Monter un fichier qu'OBS écrit encore produirait chez le stockage un rush
    // tronqué qui a l'air complet — le pire des deux résultats.
    expect(journal.begin).toHaveLength(0)
  })

  it('ne remonte pas ce qui est déjà chez le stockage', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub)
    await demanderEtAttendre(m, UN_RUSH.file)
    const premiers = journal.begin.length

    await demanderEtAttendre(m, null)
    expect(journal.begin).toHaveLength(premiers)
  })
})

describe('le plafond de débit', () => {
  it('attend entre deux parts pour tenir la moyenne demandée', async () => {
    const { hub } = fauxHub()
    let horloge = 0
    const m = monter(hub, {
      politique: () => ({ ...DEFAULT_VOD_POLICY, actif: true, debitMaxOctetsS: PART / 2 }),
      // Chaque envoi prend une seconde ; le plafond en allowed deux par part.
      now: () => (horloge += 500),
    })
    await demanderEtAttendre(m, UN_RUSH.file)

    // Une part de 8 Mo sous un plafond de 4 Mo/s doit prendre deux secondes :
    // envoyée en une, on attend le complément. Grain grossier, mais c'est la
    // taille de part qui le règle, et elle est visible dans la console.
    expect(m.attentes.length).toBeGreaterThan(0)
    expect(m.attentes.every((ms) => ms > 0)).toBe(true)
  })

  it('n\'attend pas quand aucun plafond n\'est réglé', async () => {
    const { hub } = fauxHub()
    const m = monter(hub)
    await demanderEtAttendre(m, UN_RUSH.file)
    expect(m.attentes).toEqual([])
  })
})

describe('ce qui empêche de monter', () => {
  it('reporte sans rien envoyer pendant un enregistrement, et dit pourquoi', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub, { enregistre: () => true })
    await demanderEtAttendre(m, UN_RUSH.file)

    expect(journal.begin).toHaveLength(0)
    const vue = m.televersements.vue()
    expect(vue.verdict.allowed).toBe(false)
    // Le motif est rendu jusqu'à l'écran : une attente muette se lit comme un
    // bouton mort, et l'opérateur reclique.
    expect(vue.verdict.text).toContain('enregistrement')
  })

  it('n\'envoie rien tant que le hub est injoignable', async () => {
    const m = monter(null)
    await demanderEtAttendre(m, UN_RUSH.file)
    expect(m.envois).toHaveLength(0)
    expect(m.televersements.vue().entries[0]?.state).toBe('attente')
  })

  it('ne part pas tout seul quand l\'automatique est éteint', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub, { politique: () => DEFAULT_VOD_POLICY })
    await m.televersements.passe()
    expect(journal.begin).toHaveLength(0)
  })

  it('part tout seul quand le hub l\'a activé', async () => {
    const { hub, journal } = fauxHub()
    const m = monter(hub)
    await m.televersements.passe()
    expect(journal.begin.map((b) => b.kind)).toEqual(['rush', 'sidecar'])
  })
})

describe('annuler', () => {
  it('arrête entre deux parts et demande l\'abandon au hub', async () => {
    const { hub, journal } = fauxHub()
    let m: Montage
    const editing = monter(hub, {
      envoyerPart: async (url, corps) => {
        // Annulation en pleine montée, comme un clic en régie.
        void m.televersements.annuler(UN_RUSH.file)
        return `"etag-${corps.byteLength}"`
      },
    })
    m = editing
    await demanderEtAttendre(editing, UN_RUSH.file)

    // Une part de plus, pas tout le rush : c'est ce qui rend l'annulation
    // effective en secondes plutôt qu'à la fin d'un fichier de trois gigaoctets.
    expect(editing.envois.length).toBeLessThan(4)
    expect(journal.complete).toHaveLength(0)
    expect(journal.abort).toContain(`up-${UN_RUSH.file}`)
    expect(editing.televersements.vue().entries[0]?.state).toBe('abandonne')
  })
})

describe('la vue de la régie', () => {
  it('donne un pourcentage utilisable, et l\'erreur quand il y en a une', async () => {
    const { hub } = fauxHub()
    const m = monter(hub)
    await demanderEtAttendre(m, UN_RUSH.file)

    const [entree] = m.televersements.vue().entries
    expect(entree?.state).toBe('termine')
    expect(entree?.percent).toBe(100)
    expect(entree?.error).toBeNull()
  })

  it('oublie les fichiers que le disque n\'a plus', async () => {
    const { hub } = fauxHub()
    let presents: CandidatVod[] = [UN_RUSH]
    const m = monter(hub, { candidats: async () => presents })
    await demanderEtAttendre(m, UN_RUSH.file)
    expect(m.televersements.vue().entries.length).toBeGreaterThan(0)

    // Le rush a été effacé après rapatriement : « terminé » sur un fichier
    // absent encombrerait la modale toute la journée.
    presents = []
    await m.televersements.oublierLesDisparus()
    expect(m.televersements.vue().entries).toEqual([])
  })
})

describe('quand le stockage ne répond pas', () => {
  /** Un port qu'on vient de refermer : il refuse, il ne fait pas attendre. */
  async function portFerme(): Promise<number> {
    const { createServer } = await import('node:net')
    const serveur = createServer()
    await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok))
    const port = (serveur.address() as { port: number }).port
    await new Promise<void>((ok) => serveur.close(() => ok()))
    return port
  }

  it('nomme l\'hôte et le motif errno, pas « fetch failed »', async () => {
    // Le message que Node pose sur ses pannes de transport ne dit ni ce qu'on
    // visait, ni pourquoi ça n'a pas répondu. En régie, un soir d'événement,
    // « fetch failed » sur cinq rushes envoie chercher la panne partout sauf
    // là où elle est.
    const port = await portFerme()
    const { hub } = fauxHub()
    // Le vrai chemin réseau, sans `envoyerPart` : c'est lui qu'on veut voir
    // échouer, et c'est lui qui fabrique le message.
    const m = monter(hub, { envoyerPart: undefined })
    const urlLocale = (numero: number) => `http://127.0.0.1:${port}/part/${numero}`
    hub.parts = async (_id, numeros) =>
      numeros.map((numero) => ({
        numero,
        url: urlLocale(numero),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }))

    await demanderEtAttendre(m, UN_RUSH.file)

    const erreur = m.televersements.vue().entries[0]?.error ?? ''
    expect(erreur).toContain('Stockage injoignable')
    // L'hôte visé, sans la signature ni les identifiants de l'adresse : le
    // journal d'une salle se relit à plusieurs.
    expect(erreur).toContain(`127.0.0.1:${port}`)
    expect(erreur).not.toContain('X-Amz-Signature')
    // Et un motif errno, qui distingue un service éteint d'un nom introuvable
    // ou d'un pare-feu qui laisse pendre — trois pannes qui ne se corrigent pas
    // au même endroit. Lequel exactement dépend du système : ce qui compte est
    // qu'il y en ait un, là où « fetch failed » les confondait toutes.
    expect(erreur).toMatch(/E[A-Z]{4,}/)
  })
})
