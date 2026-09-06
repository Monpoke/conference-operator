# Déployer le hub sur Kubernetes

Ces manifestes déploient **le hub**, et lui seul : l'image publiée par un tag,
avec sa base et son ingress. Les régies de salle ne se déploient pas — elles
s'installent depuis la release, sur les machines des salles.

```bash
# 1. le secret, qui n'est pas dans le dépôt
kubectl create namespace conference-operator
kubectl -n conference-operator create secret generic hub \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 48)"

# 2. le reste
kubectl apply -k manifests/
```

Le `newTag` du dépôt reste à `0.0.0`, comme les `package.json` : **le numéro
n'existe que dans le tag.** Chaque release publie un
`manifests-<version>.tar.gz` où il est déjà écrit — c'est la façon de déployer
une version sans tenir dans git un chiffre qui serait faux entre deux
publications :

```bash
tar xzf manifests-1.2.0.tar.gz
kubectl apply -k manifests/
```

Pour déployer une version depuis le dépôt sans passer par l'archive, la ligne
qui pose le numéro au bon endroit :

```bash
cd manifests && kustomize edit set image ghcr.io/monpoke/conference-operator/hub:1.2.0
```

## Ce qu'il faut régler avant

| Où | Quoi |
|---|---|
| `configmap.yaml` | `PUBLIC_URL`, l'adresse **publique** du hub, et `PROGRAM_SOURCE_URL` |
| `ingress.yaml` | l'hôte, la classe d'ingress, le secret TLS |
| `pvc.yaml` | la `storageClassName`, si le cluster n'en a pas de défaut |

`PUBLIC_URL` est la seule qu'on ne peut pas deviner à votre place : Better Auth
signe ses cookies avec, et l'adresse qu'un opérateur lit pour appairer une salle
en découle. Renseignée avec l'adresse du service au lieu de celle du navigateur,
l'appairage envoie les gens nulle part.

Puis créer un compte opérateur — l'inscription publique est fermée, et sans lui
la console est inaccessible :

```bash
kubectl -n conference-operator exec deploy/hub -- \
  node --import tsx src/cli/operator.ts vous@exemple.fr "Régie" <mot-de-passe>
```

## Trois contraintes, et leur raison

**Une seule réplique, et ce n'est pas un point de départ.** Le hub garde son état
dans un fichier SQLite et diffuse ses WebSockets en mémoire — une décision de ce
dépôt, qui supprime Redis et rend les tests exécutables sans conteneur. Deux
répliques se disputeraient le même fichier et ne connaîtraient chacune que leurs
propres salles.

**`strategy: Recreate`, pas la mise à jour progressive.** Un déploiement qui
démarre le nouveau pod avant que l'ancien ait lâché mettrait deux écrivains sur
un fichier SQLite. Ça coûte quelques secondes d'interruption à chaque
déploiement : c'est une chose à faire hors événement, pas une chose à rendre
concurrente.

**Le proxy doit laisser vivre les WebSockets.** Les salles reçoivent leurs
commandes et remontent leur état par `/ws`. Un ingress qui ferme les connexions
inactives au bout d'une minute donne des salles qui se reconnectent toute la
journée — ça se lit comme un réseau instable, c'est un délai d'expiration. Les
annotations fournies sont celles d'ingress-nginx ; avec un autre contrôleur, le
réglage change de nom, pas de nécessité.

## Ce qui n'y est pas

- **Les rushes.** Renseigner `S3_*` dans le secret les fait rapatrier vers un
  stockage compatible S3 ; sans eux, les salles gardent leurs fichiers. Les trois
  premières variables vont ensemble : deux sur trois empêchent le hub de
  démarrer, plutôt que de monter une console qui annonce un stockage où tout
  échoue.
- **Les sauvegardes.** Le volume porte la base : programme, opérateurs,
  appairages, modération du jour. Rien ici ne la sauvegarde.
- **L'autoscaling, un PodDisruptionBudget, un HPA.** Ils n'auraient pas de sens
  sur une réplique unique.

## Une réserve

Ces manifestes ont été rendus et relus (`kubectl kustomize manifests/`), **pas
appliqués sur un cluster**. Le premier déploiement mérite d'être regardé :
`kubectl -n conference-operator logs deploy/hub -f`, le temps que les migrations
passent et que le programme s'importe.
