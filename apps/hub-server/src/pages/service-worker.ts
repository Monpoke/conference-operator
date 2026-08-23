import { IDENTITE_PAR_DEFAUT, type EventIdentity } from '@cloudnord/contract'

export interface ServiceWorkerOptions {
  /**
   * Identité de l'événement, figée dans le worker au moment où il est servi.
   *
   * Un avis poussé arrive parfois sans charge utile lisible : c'est alors le
   * seul nom dont le worker dispose pour titrer la notification. Le lire du
   * hub plutôt que l'écrire en dur est ce qui permet au même binaire de servir
   * deux événements.
   */
  event?: EventIdentity
}

/**
 * Service worker de la console.
 *
 * Sa seule raison d'être : recevoir une notification quand la console est
 * fermée. Il ne met rien en cache — la console est servie par le hub qu'elle
 * pilote, et un cache la ferait mentir sur l'état des salles, qui est
 * exactement ce qu'elle est censée dire.
 *
 * Servi à la racine (`/sw.js`) et non sous `/admin/` : la portée d'un service
 * worker est celle de son chemin, et un worker servi sous `/admin/` ne
 * couvrirait pas les autres pages du hub.
 */
export function renderServiceWorker(options: ServiceWorkerOptions = {}): string {
  const identite = options.event ?? IDENTITE_PAR_DEFAUT
  return `/* Généré par le hub — voir src/pages/service-worker.ts */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (evenement) => evenement.waitUntil(self.clients.claim()))

self.addEventListener('push', (evenement) => {
  /*
   * Un avis sans corps lisible reste un avis.
   *
   * Certains services de push réveillent le worker sans charge utile ; se taire
   * alors serait le pire des deux mondes — le téléphone a vibré, et l'écran ne
   * dit rien.
   */
  let avis = { title: ${JSON.stringify(identite.shortName)}, body: 'Quelque chose a changé sur le hub.', tag: 'hub' }
  try {
    if (evenement.data) avis = { ...avis, ...evenement.data.json() }
  } catch {}

  evenement.waitUntil(
    self.registration.showNotification(avis.title, {
      body: avis.body,
      // Même étiquette que les notifications de la page : quand la console est
      // ouverte *et* abonnée, le second avis remplace le premier au lieu
      // d'empiler deux fois la même information.
      tag: avis.tag,
      lang: 'fr',
      data: { vue: avis.vue ?? 'exploitation' },
    }),
  )
})

self.addEventListener('notificationclick', (evenement) => {
  evenement.notification.close()
  const vue = (evenement.notification.data && evenement.notification.data.vue) || 'exploitation'
  const cible = vue === 'exploitation' ? '/admin' : '/admin/' + vue

  evenement.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenetres) => {
      // Une console déjà ouverte est ramenée au premier plan plutôt que
      // dupliquée : deux onglets qui se rafraîchissent en parallèle finissent
      // par afficher deux états différents.
      for (const fenetre of fenetres) {
        if (fenetre.url.includes('/admin')) {
          return fenetre.focus().then((focalisee) => focalisee.navigate(cible))
        }
      }
      return self.clients.openWindow(cible)
    }),
  )
})
`
}
