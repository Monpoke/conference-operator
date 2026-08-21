# Migrations

Deux jeux distincts : `migrations/hub` (base du hub) et `migrations/client`
(base locale d'une machine de salle). Chacun a son schéma dans `src/hub` et
`src/client`.

## Règle

**Ne jamais régénérer une migration déjà publiée.** Ajouter un fichier, puis
sceller :

```bash
pnpm --filter @cloudnord/db generate:hub
pnpm --filter @cloudnord/db generate:client
pnpm --filter @cloudnord/db sceller
```

## Le sceau

`migrations/<jeu>/empreintes.json` fige le SHA-256 de chaque migration publiée —
la même grandeur que Drizzle stocke dans `__drizzle_migrations`. Un test
(`test/migrations-scellees.test.ts`) échoue si un fichier publié est modifié ou
supprimé ; une migration *nouvelle* passe sans bruit, puisque c'est le geste
normal.

La règle était auparavant une convention écrite ici, et elle a été enfreinte
plusieurs fois pendant le développement — à chaque fois au prix de la base du
hub. Elle est désormais vérifiée.

`pnpm --filter @cloudnord/db sceller` sert à enregistrer un ajout, **pas** à
faire taire une anomalie : sceller une ligne de base régénérée réintroduit
exactement le défaut que la vérification existe pour attraper.

Drizzle enregistre dans `__drizzle_migrations` le *hash* de chaque migration
appliquée. Supprimer puis regénérer la ligne de base produit un hash différent :
sur une base existante, Drizzle ne reconnaît plus rien, rejoue les `CREATE TABLE`
et échoue avec « table already exists ».

C'est exactement ce qui s'est produit pendant le développement, où la ligne de
base a été régénérée plusieurs fois tant que rien n'était installé. À partir du
moment où une base existe ailleurs que sur son propre poste, ce n'est plus une
option.

## Quand une base est bloquée

Les deux applications détectent le cas et affichent la marche à suivre plutôt
qu'une trace Drizzle. Le premier réflexe est de restaurer les migrations
(`git checkout -- packages/db/migrations`), pas de supprimer la base. La
suppression est un dernier recours, et voici ce qu'elle coûte :

| Base | Emplacement | Ce qu'on perd |
|---|---|---|
| hub | `apps/hub-server/data/` | comptes opérateurs, appairages, modération, états de conférence |
| salle | `<userData>` ou `.donnees-locales/` | cache du programme, file de remontée non vidée |

Côté salle, **vérifier d'abord que le compteur d'événements en attente est à
zéro** : sinon la suppression perd des enregistrements et des marqueurs non
encore remontés.

## En production

Une migration additive s'applique seule au démarrage. Pour un changement
destructeur, sauvegarder d'abord — le hub est répliqué en continu par Litestream,
et un `VACUUM INTO` horodaté avant l'opération coûte quelques secondes.
