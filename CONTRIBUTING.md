# Contribuer

Merci de l'intérêt. Ce dépôt fait tourner une régie d'événement réelle : trois
salles, une journée, aucune session de rattrapage. Les conventions ci-dessous
existent parce qu'un défaut ici ne se découvre pas en recette mais devant
quatre cents personnes.

## Démarrer

```bash
corepack enable && pnpm install
pnpm test        # 1391 tests
pnpm typecheck
```

Node 22 ou plus, pnpm 10 (la version exacte est figée par `packageManager`).
Pour lancer le hub et un client de salle, voir la section « Lancer en local » du
[README](README.md) — le mode `dev:headless` du client permet de tout faire
sans Electron ni OBS, y compris sous WSL ou sur une machine distante.

## Ce qui se relit à l'œil

Les pages n'ont pas de suite de tests visuels. Deux générateurs produisent des
aperçus HTML statiques à partir des **vraies** pages et des **vraies** données :

```bash
pnpm --filter @conference-operator/room-client preview ./preview   # écran de salle, habillages
pnpm --filter @conference-operator/hub-server  preview ./preview   # mur public
```

Ouvrez-les dans un navigateur. Toute modification qui touche à une page doit
être relue là avant d'être proposée. Les aperçus sont ignorés par git : ce sont
des artefacts, pas des sources.

**La console et la régie font exception, et c'est structurel.** Un fichier HTML
autonome s'ouvre depuis le disque ; une application Vue, non — le navigateur
refuse ses modules servis en `file://`. Les remplacer par des aperçus qui ne
seraient plus les pages servies ferait perdre exactement ce qui rendait ces
fichiers utiles. On les relit donc en les lançant :

```bash
pnpm --filter @conference-operator/hub-admin dev   # puis MODE=dev pnpm dev côté hub

# La régie a besoin d'une salle derrière elle : le poste proxifie Vite, jamais
# l'inverse — c'est lui qui porte le flux d'état, les actions et le vumètre.
pnpm --filter @conference-operator/control-web dev
REGIE_VITE_ORIGIN=http://127.0.0.1:5174 pnpm --filter @conference-operator/room-client dev:headless

# La régie **mobile** est la même application, servie par le hub sur /regie.
# Le même serveur Vite convient : les deux hôtes la servent sous /regie/.
REGIE_VITE_ORIGIN=http://127.0.0.1:5174 MODE=dev pnpm --filter @conference-operator/hub-server dev
```

Les deux portées se relisent séparément, et il le faut : la disposition mobile
n'est pas la disposition de poste réduite par masquage, et un panneau qui rend
du vide à distance ne se voit pas en local.

Les jeux de données figés qui alimentaient leurs aperçus n'ont pas été perdus :
ils vivent dans `apps/hub-admin/test/fixtures/console.ts` et
`apps/control-web/test/fixtures.ts`, où ils servent aux tests — et où le
compilateur vérifie qu'ils décrivent des états que le hub et la salle peuvent
réellement produire.

## Conventions

### Le *pourquoi*, toujours

Les commentaires ne décrivent pas ce que fait la ligne suivante — ils disent
**pourquoi elle est comme ça** : quelle contrainte, quel défaut déjà rencontré,
quel arbitrage. Un commentaire qui paraphrase le code sera retiré en relecture ;
un bloc de code non évident qui n'explique pas son pourquoi se verra demander le
sien.

### La langue : code en anglais, libellés en français

**Tout le code est en anglais**, sans exception : identifiants, noms de
fichiers, commentaires, titres de tests, classes CSS, ids du DOM, scripts npm.
C'est la langue des bibliothèques qu'on assemble, et garder deux langues dans un
même fichier coûte plus que d'en choisir une. Il n'y a plus de « module
français » : la conversion a été faite en bloc, et une exception rouvrirait la
frontière qu'elle a fermée.

**Tout ce que lit un humain reste en français**, sans exception non plus : les
libellés des trois fronts — écran de salle, régie, console —, les messages
qu'un opérateur voit passer, les bannières des scripts de développement, le nom
du produit installé, les notes de publication, et cette documentation. Une
traduction n'a pas à reformuler ce qui s'affiche : « Délai de grâce » est le
terme des conversations de la journée, et le remplacer par un synonyme
obligerait à traduire mentalement à chaque fois.

Un fichier porte donc les deux : du code anglais qui produit des chaînes
françaises. Quand la chaîne dépend d'une valeur, elle passe par une table de
libellés plutôt que par l'interpolation d'un identifiant — voir `SOURCE_LABELS`
dans `apps/room-client/src/main/hub-address.ts`, qui rend « environnement » à
partir de `'environment'`.

#### Le glossaire

Les mots du métier ont chacun une traduction, et une seule. Un synonyme ajouté
au hasard d'un fichier rend le code ingrepable, ce qui est exactement le défaut
que la règle évite.

| français | anglais |
| --- | --- |
| régie (l'application) | control |
| salle | room |
| conférence, talk | talk |
| créneau | slot |
| mur public | wall |
| appairage | pairing |
| verrou | lock |
| captation | recording |
| téléversement | upload |
| programme | program |
| repère | anchor |
| débit | rate |
| jauge | gauge |
| réglages | settings |
| porte (vers une salle) | gateway |

#### Ce qui reste en français dans le code

Ces valeurs traversent un réseau, un disque ou une base de données. Les
renommer casserait un contrat, une migration ou un appairage déjà posé, sans
rien rendre en lisibilité. Elles sont figées telles quelles, quelle que soit
leur langue, et une valeur figée ne se renomme pas « au passage » :

- **les procédures et les champs du contrat oRPC** : `regie.*`,
  `program.controleOpenFeedback`, `dureeMs`, `recues`, `etapes`, `objets`,
  `captations`, `televersements`, `salles`, `portee`, `conference` ;
- **les valeurs d'énumération du contrat** : `aucune`, `pause`,
  `pas-commencee`, `retard`, `en-cours`, `fin-proche`, `terminee`,
  `depassement`, `a-venir`, `RAZ`, `inconnu`, `expire`, `attente`, `termine`,
  `abandonne`, `echoue`, `debut`, `fin`, `ok`, `suspect`, `illisible`, `auto`,
  `operateur`, `rien`, `essentiel`, `tout`, `technique`, `exploitation`,
  `sans-stockage`, `auto-desactive` ;
- **les routes HTTP** : `/mur`, `/regie/:roomId`, `/admin/*`, `/rpc`, `/ws`,
  `/health`, `/display/*` ;
- **les tables et colonnes SQLite**, et les propriétés Drizzle qui les portent :
  `televersement`, `tailleOctets`, `octetsEnvoyes`, `debitOctetsS`, `manuel`,
  `demandeA`, `commenceA`, `finiA`, `taillePartOctets`, `partsJson` ;
- **les noms de vues du routeur**, qui sont dans les URL de la console :
  `appairage`, `exploitation`, `developpement`, `moderation`, `reglages`,
  `vod`, `messages`, `conferences` ;
- **les clés de `localStorage`, les en-têtes et les paramètres d'URL** :
  `mur-device`, `mur-votes`, `mur-salle`, `hub-admin`, `hub-notifs`,
  `regie-session`, `x-regie-session`, `x-room-client-id`, `vue`, `salle`,
  `duree` ;
- **les ids du DOM que la coquille sert** : `etat-initial`, `regie-portee`,
  `regie-root`, `console-boot` ;
- **les variables d'environnement** : `MODE`, `OBS_MOCK`, `OBS_REEL`,
  `HEURE_SIMULEE`, `HUB_ORIGIN`, `ROOM_ID`, `REGIE_VITE_ORIGIN`, `DATA_DIR`,
  `DISPLAY_PORT` ;
- **les fichiers écrits sur disque par une salle** : `salle.db`, `client-id`,
  `jeton`, `hub`, `assets`, `enregistrements`, `.controles-vod.json` ;
- **les canaux IPC d'Electron** : `hub:tester`, `hub:valider`.

Le code qui les manipule, lui, est en anglais : `const upload = row.televersement`
est la forme attendue, pas l'inverse.

### Les pages d'affichage n'ont pas d'étape de build

L'écran de salle, les deux habillages, le mur public et l'écran d'adresse du hub
sont des gabarits littéraux TypeScript qui produisent un document HTML complet et
autonome. Ils doivent s'ouvrir sans réseau, sans CDN et sans bundler — c'est ce
qui fait qu'une salle continue de fonctionner quand le réseau de l'événement
tombe.

**La console du hub et la régie, elles, sont des applications Vue**
(`apps/hub-admin`, `apps/control-web`) : le processus qui les sert rend une
coquille et sert leur bundle. La régie en a **deux** — la machine de salle et le
hub —, et l'invariant vaut pour les deux coquilles. L'invariant n'est pas abandonné pour autant, il est
reformulé — parce que ce qu'il protégeait était le réseau, pas la balise :

> Une page servie ne référence **aucune ressource hors de son origine**. Tout
> `src` et tout `href` est relatif.

Un asset servi par le processus qui sert déjà la page ne peut pas disparaître
d'une coupure du réseau de l'événement ; n'importe quelle autre origine, si.
Vérifié par `apps/hub-server/test/public-pages.test.ts` pour la console, et par
`apps/room-client/test/control-served.test.ts` pour la régie — où il pèse plus
lourd encore : la machine de salle tourne parfois sans réseau du tout.

En conséquence, pour les pages restées des gabarits :

- **aucun `<script src>`, aucun `<link href>`, aucun `@import url`.** Tout est
  inliné. Vérifié par `apps/room-client/test/standalone-pages.test.ts` ;
- **aucun accent grave nu** dans le corps d'un gabarit. Un backtick oublié dans
  un commentaire referme la chaîne, et TypeScript signale alors une erreur à
  cent lignes de la cause. Vérifié par le même fichier ;
- le JavaScript embarqué doit rester analysable : il vit dans une chaîne, où le
  compilateur ne voit rien. Vérifié aussi.

### La feuille Tailwind est compilée, puis figée

`packages/ui/src/generated/styles.ts` est **généré**. Toute nouvelle classe
Tailwind employée dans une page impose de le régénérer :

```bash
pnpm --filter @conference-operator/ui build
```

Sans cela la classe n'a tout simplement aucun style : rien ne lève, rien ne
casse au typage, l'écran s'affiche de travers et on le découvre en salle.
`packages/ui/test/sheet-up-to-date.test.ts` recompile et compare, pour que
l'oubli soit une erreur de test plutôt qu'une mauvaise surprise.

Le CSS qui n'est pas exprimable en utilitaires — keyframes, dégradés composés
avec `color-mix`, règles pilotées par un attribut `data-*` — vit dans le bloc
`<style>` de la page concernée et échappe donc à cette contrainte.

### L'écran de salle se dimensionne en `vmin`

D'un vidéoprojecteur 1024×768 à un 4K selon les salles. Des tailles en `rem` ou
en `px` donneraient un texte minuscule sur l'un et débordant sur l'autre. Tout
passe par des valeurs arbitraires : `text-[3vmin]`, `p-[4.5vmin]`,
`rounded-[1.4vmin]`. Aucune exception.

### Le flux d'état est différentiel, et vérifié dans les deux sens

Les pages reçoivent leur état par SSE, champ par champ, et chaque vue ne reçoit
que ce qu'elle lit. `apps/room-client/test/stream-views.test.ts` relit le source
d'une page, en extrait les `donnees.<champ>` et exige une correspondance exacte
avec `FIELDS_BY_VIEW` : un champ lu mais non poussé fait échouer les tests, un
champ poussé mais plus lu aussi.

### Les migrations sont scellées

Une migration publiée ne se réécrit pas — les salles ont déjà appliqué la
leur. `packages/db/test/migrations-sealed.test.ts` le garantit. Pour changer
un schéma, ajoutez une migration.

## Tests

`vitest`, avec `happy-dom` pour tout ce qui monte une page dans un vrai DOM. Un
test doit dire *quelle propriété on tient* et pourquoi elle compte : les noms
et les commentaires des tests existants donnent le ton.

Une correction de défaut arrive avec le test qui échouait avant elle.

## Proposer un changement

1. une branche par sujet ;
2. `pnpm typecheck && pnpm test` au vert, et la feuille régénérée si nécessaire ;
3. les aperçus relus si une page a bougé ;
4. dans la description : ce qui change à l'écran, et ce que vous avez vérifié —
   la case « lancé pour de vrai » vaut plus que la case « les tests passent ».

## Les messages de commit

Format Conventional Commits, en français : `type(scope): sujet`.
`commitlint.config.js` porte la règle, le hook `commit-msg` la vérifie au
moment du commit, et la CI la rejoue sur les commits d'une proposition.

```
feat(control): couches de raccourcis clavier
fix(hub): le RAZ efface les prises du journal d'ingestion
refactor(ui): supprime components.css, plus aucune page ne le lit
```

Le sujet dit l'intention plutôt que le geste : « ne plus répéter le logo d'un
sponsor multi-paliers » plutôt que « modifie renderSponsors ». Sans majuscule
initiale ni point final, 72 caractères au plus, type et scope compris. Deux
« et » dans un sujet valent deux commits.

Les scopes sont fermés, et la liste vit dans `commitlint.config.js` : les douze
répertoires de `apps/` et `packages/` — `console` pour `hub-admin`, `hub` pour
`hub-server`, `control` pour `control-web` — plus `vod`, `deps`, `dev`,
`docker` et `repo`.

Le hook est posé par `prepare`, donc par n'importe quel `pnpm install`. Il ne
part pas avec le dépôt : un clone qui n'a jamais installé ne l'a pas.
