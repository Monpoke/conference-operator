# Contribuer

Merci de l'intérêt. Ce dépôt fait tourner une régie d'événement réelle : trois
salles, une journée, aucune session de rattrapage. Les conventions ci-dessous
existent parce qu'un défaut ici ne se découvre pas en recette mais devant
quatre cents personnes.

## Démarrer

```bash
corepack enable && pnpm install
pnpm test        # 1227 tests
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
pnpm --filter @cloudnord/room-client preview ./apercu   # écran de salle, habillages
pnpm --filter @cloudnord/hub-server  preview ./apercu   # mur public
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
pnpm --filter @cloudnord/hub-admin dev   # puis MODE=dev pnpm dev côté hub

# La régie a besoin d'une salle derrière elle : le poste proxifie Vite, jamais
# l'inverse — c'est lui qui porte le flux d'état, les actions et le vumètre.
pnpm --filter @cloudnord/regie-web dev
REGIE_VITE_ORIGIN=http://127.0.0.1:5174 pnpm --filter @cloudnord/room-client dev:headless
```

Les jeux de données figés qui alimentaient leurs aperçus n'ont pas été perdus :
ils vivent dans `apps/hub-admin/test/fixtures/console.ts` et
`apps/regie-web/test/fixtures.ts`, où ils servent aux tests — et où le
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

**Tout ce qui s'écrit aujourd'hui est en anglais** — identifiants, noms de
fichiers, commentaires. C'est la langue de `packages/format`,
`packages/hub-client`, `packages/components` et des applications Vue, et celle
des bibliothèques qu'on y assemble : garder deux langues dans un même fichier
coûte plus que d'en choisir une.

**Ce que lit un opérateur reste en français, sans exception.** Une migration n'a
pas à reformuler ce qui s'affiche : « Délai de grâce » est le terme des
conversations de la journée, et le remplacer par un synonyme obligerait à
traduire mentalement à chaque fois.

Deux frontières, pour que la règle ne se transforme pas en chantier :

- **les modules français existants ne sont pas renommés.** Renommer l'API de
  `@cloudnord/etat-salle` — `apparenceDe`, `etatDesCreneaux`,
  `conferenceAPiloter` — se propagerait au contrat, au hub, au client et à un
  millier de tests, pour un gain nul. Une fonction ajoutée à un fichier français
  suit la convention de son fichier ;
- **le vocabulaire métier reste français** là où il nomme le produit : `regie`,
  `salle`, `conference`, `creneau` sont les mots du RUNBOOK et de l'étiquette
  collée sur la machine.

### Les pages d'affichage n'ont pas d'étape de build

L'écran de salle, les deux habillages, le mur public et l'écran d'adresse du hub
sont des gabarits littéraux TypeScript qui produisent un document HTML complet et
autonome. Ils doivent s'ouvrir sans réseau, sans CDN et sans bundler — c'est ce
qui fait qu'une salle continue de fonctionner quand le réseau de l'événement
tombe.

**La console du hub et la régie, elles, sont des applications Vue**
(`apps/hub-admin`, `apps/regie-web`) : le processus qui les sert rend une
coquille et sert leur bundle. L'invariant n'est pas abandonné pour autant, il est
reformulé — parce que ce qu'il protégeait était le réseau, pas la balise :

> Une page servie ne référence **aucune ressource hors de son origine**. Tout
> `src` et tout `href` est relatif.

Un asset servi par le processus qui sert déjà la page ne peut pas disparaître
d'une coupure du réseau de l'événement ; n'importe quelle autre origine, si.
Vérifié par `apps/hub-server/test/public-pages.test.ts` pour la console, et par
`apps/room-client/test/regie-servie.test.ts` pour la régie — où il pèse plus
lourd encore : la machine de salle tourne parfois sans réseau du tout.

En conséquence, pour les pages restées des gabarits :

- **aucun `<script src>`, aucun `<link href>`, aucun `@import url`.** Tout est
  inliné. Vérifié par `apps/room-client/test/pages-autonomes.test.ts` ;
- **aucun accent grave nu** dans le corps d'un gabarit. Un backtick oublié dans
  un commentaire referme la chaîne, et TypeScript signale alors une erreur à
  cent lignes de la cause. Vérifié par le même fichier ;
- le JavaScript embarqué doit rester analysable : il vit dans une chaîne, où le
  compilateur ne voit rien. Vérifié aussi.

### La feuille Tailwind est compilée, puis figée

`packages/ui/src/generated/styles.ts` est **généré**. Toute nouvelle classe
Tailwind employée dans une page impose de le régénérer :

```bash
pnpm --filter @cloudnord/ui build
```

Sans cela la classe n'a tout simplement aucun style : rien ne lève, rien ne
casse au typage, l'écran s'affiche de travers et on le découvre en salle.
`packages/ui/test/feuille-a-jour.test.ts` recompile et compare, pour que
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
que ce qu'elle lit. `apps/room-client/test/vues-du-flux.test.ts` relit le source
d'une page, en extrait les `donnees.<champ>` et exige une correspondance exacte
avec `CHAMPS_PAR_VUE` : un champ lu mais non poussé fait échouer les tests, un
champ poussé mais plus lu aussi.

### Les migrations sont scellées

Une migration publiée ne se réécrit pas — les salles ont déjà appliqué la
leur. `packages/db/test/migrations-scellees.test.ts` le garantit. Pour changer
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

Les messages de commit sont en français, à l'impératif, et disent l'intention
plutôt que le geste : « ne plus répéter le logo d'un sponsor multi-paliers »
plutôt que « modifie rendreSponsors ».
