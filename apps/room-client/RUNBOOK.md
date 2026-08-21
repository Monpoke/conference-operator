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
5. Vérifier le panneau **Diagnostic** : les deux OBS doivent être verts et
   **aucun rôle ne doit apparaître en rouge**. Un rôle rouge = une scène OBS
   renommée ou absente. Corriger maintenant, pas pendant un talk.
6. Dans OBS-A, vérifier que la scène `HOLD` contient bien une Browser Source sur
   `http://127.0.0.1:7788/display/projector`, et OBS-B une source transparente
   sur `http://127.0.0.1:7788/display/overlay`.

---

## Déroulé d'un talk

| Moment | Geste |
|---|---|
| Avant | Écran sur **Sponsors** ou **Programme**, projection sur **Habillage** (`H`) |
| Le speaker branche | Projection sur **Direct** (`L`) |
| Début du talk | **Commencer** puis **Enregistrer** (`R`) |
| Moment marquant | **Marquer** (`M`) — saisir un libellé, ou laisser « Chapitre » |
| Fin du talk | **Arrêter** (`R`), puis projection sur **Habillage** (`H`) |
| Entre deux | Écran sur **Compte à rebours** ou **Mur** |

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

1. Basculer immédiatement l'écran sur **Sponsors**.
2. Prévenir la personne qui modère (`/admin`) pour qu'elle rejette le message.
3. Rebasculer sur **Mur** une fois confirmé.

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
