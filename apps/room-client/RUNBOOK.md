# Procédures de salle — Cloud Nord 2026

À imprimer et poser à côté du PC de régie. Chaque procédure suppose que
l'opérateur a l'application ouverte et rien d'autre.

---

## Mise en route (à faire la veille, pas le jour J)

1. Brancher capture HDMI, caméra, projecteur. Lancer **OBS-A** puis **OBS-B**.
2. Lancer **Régie Cloud Nord**. Deux fenêtres s'ouvrent : la régie sur l'écran
   opérateur, la projection sur l'écran secondaire.
3. Au premier lancement, la régie demande **quelle salle dessert ce poste**.
   Choisir la bonne : la console la retrouvera pré-sélectionnée.
4. La régie affiche ensuite un **code d'appairage**. Le donner à la personne qui
   tient la console hub (`/admin`), qui vérifie la salle et approuve.
   *Le code expire au bout de 30 minutes ; relancer l'application en régénère un.*
5. Vérifier le panneau **Diagnostic**. Quatre choses, dans cet ordre :
   - les deux OBS **verts** ;
   - **aucun rôle en rouge** — un rôle rouge = une scène renommée ou absente ;
   - **aucun badge « simulé »** — un OBS simulé se pilote exactement comme un
     vrai, mais ne capte rien ;
   - **aucun badge de mode** près du nom de la salle, en haut à gauche : le jour
     J, salle et hub sont en production.

   Corriger maintenant, pas pendant un talk. Bouton **⚙** dans l'en-tête : la
   première ligne de chaque instance porte son adresse et son mot de passe, les
   listes en dessous le choix des scènes — elles sont lues sur OBS. Puis
   **Connecter** sur la ligne de l'instance concernée : reconnecter la
   projection ne touche pas à la captation, et le bouton se bloque sur une
   instance qui enregistre. Le hub doit être joignable pour enregistrer un
   réglage.
6. Dans OBS-A, vérifier que la scène `HOLD` contient bien une Browser Source sur
   `http://127.0.0.1:7788/display/projector`, la scène `LIVE` une source
   transparente sur `http://127.0.0.1:7788/display/overlay-live`, et OBS-B une
   source transparente sur `http://127.0.0.1:7788/display/overlay`.

   **`overlay-live` ne va jamais dans OBS-B.** Il porte aussi les messages de la
   console — « on reprend dans 5 minutes » — et tout ce qui entre dans OBS-B est
   gravé dans la VOD. La question du public, elle, part bien en VOD, mais par
   `overlay`, qui ne porte qu'elle.

---

## Déroulé d'un talk

| Moment | Geste |
|---|---|
| Avant | Écran sur **Boucle** — le défaut —, projection sur **Habillage** (`H`) |
| Le speaker branche | Projection sur **Direct** (`L`) |
| Début du talk | **Commencer** puis **Enregistrer** (`R`) |
| Moment marquant | **Marquer** (`M`) — saisir un libellé, ou laisser « Chapitre » |
| Fin du talk | **Arrêter** (`R`), puis projection sur **Habillage** (`H`) |
| Entre deux | Écran sur **Compte à rebours**, ou retour à la **Boucle** |

Le bloc « Conférence en cours » vise toujours la conférence pertinente : celle en
cours si elle a commencé, sinon **la suivante**. Entre deux talks ou pendant une
pause, « Commencer » reste donc disponible — avec l'horaire rappelé pour lever
toute ambiguïté sur laquelle on démarre.

Le message de confirmation à l'arrêt indique le nom du fichier produit. **S'il
annonce « sidecar non écrit », le noter** : ce talk demandera un montage manuel.

---

## Le réseau tombe

**Ne rien faire.** C'est prévu.

- Le bandeau passe à « hors ligne » et un compteur d'événements en attente
  apparaît. C'est normal et attendu.
- L'écran, les scènes, l'enregistrement et les marqueurs **continuent de
  fonctionner** : tout est local.
- À la reconnexion, tout remonte seul, dans l'ordre, sans doublon.

Le compteur ne redescend pas après plusieurs minutes de réseau rétabli :
prévenir la personne qui tient le hub. Ne pas redémarrer l'application — cela ne
perdrait rien, mais ne réglerait rien non plus.

**« temps réel interrompu »** (pastille orange) signifie que le hub répond mais
que le canal temps réel est coupé : le programme reste à jour, les commandes
depuis l'admin n'arrivent plus. Même consigne.

---

## OBS-A plante en pleine projection

La salle voit un écran noir ou figé.

1. Relancer OBS-A. L'application s'y reconnecte seule (quelques secondes).
2. **Si c'est trop long** : passer la fenêtre de projection de l'application en
   plein écran sur la sortie vidéoprojecteur. Elle affiche le même contenu et ne
   dépend pas d'OBS.
3. Rebasculer sur OBS quand il est revenu.

## OBS-B plante pendant un enregistrement

La prise en cours est perdue à partir du plantage — OBS écrit au fil de l'eau,
le début est sur le disque.

1. Relancer OBS-B, attendre le vert dans **Diagnostic**.
2. Relancer un enregistrement. Prévenir le montage : ce talk sera en deux parties.

---

## Le hub est injoignable au démarrage

La salle démarre quand même, sur son dernier programme en cache.

Si la machine n'a **jamais** été synchronisée, charger le programme à la main :
copier l'export JSON sur une clé USB et l'importer depuis l'application. Le
programme et les sponsors s'affichent alors normalement ; seules les commandes
à distance et la remontée sont indisponibles.

---

## Le mur affiche quelque chose d'inapproprié

Tout message est relu avant affichage : c'est donc une erreur de modération.

1. Basculer immédiatement l'écran sur **Sponsors** — une page figée, pas la
   boucle, qui repasserait sur le mur toute seule.
2. Prévenir la personne qui modère (`/admin`) pour qu'elle rejette le message.
   **Le mur est commun à l'événement** : le message est sur les trois écrans, et
   les deux autres salles ont le même geste à faire.
3. Rebasculer sur **Boucle** une fois confirmé.

---

## Fin de journée

1. Vérifier que le compteur d'événements en attente est à **zéro**. Sinon,
   laisser la machine allumée et connectée jusqu'à ce qu'il descende.
2. Récupérer le dossier d'enregistrements : chaque talk y a un `.mkv` **et** un
   `.json` du même nom. **Les deux sont nécessaires au montage** — le `.json`
   contient les intervenants et les marqueurs de chapitre.
3. Ne pas renommer les fichiers.

---

## Qui appeler

| Problème | Qui |
|---|---|
| Scène OBS, caméra, capture | régisseur technique de la salle |
| Appairage, programme, modération | personne qui tient la console hub |
| Rien ne fonctionne | couper OBS-A, projeter la fenêtre de l'application, continuer |
