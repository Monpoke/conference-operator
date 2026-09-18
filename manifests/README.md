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

## Pousser une image construite localement

Entre deux versions, pour faire tourner ce qu'on vient de construire sans passer
par un tag ni par git :

```bash
REGISTRY=registry.exemple.fr/cloudnord pnpm build:local k8s
```

Ça construit l'image, la pousse, puis épingle le **digest** poussé sur le
StatefulSet et attend la fin du redémarrage. Le cluster visé se règle par
`KUBE_CONTEXT`, `KUBE_NAMESPACE` (`conference-operator`) et `KUBE_WORKLOAD`
(`statefulset/hub`).

À la main, c'est la ligne que le script exécute :

```bash
kubectl -n conference-operator set image statefulset/hub \
  hub=registry.exemple.fr/cloudnord/hub@sha256:<digest>
kubectl -n conference-operator rollout status statefulset/hub
```

Le digest, pas le tag : entre deux constructions locales le tag ne bouge pas, et
patcher le StatefulSet avec la valeur qu'il porte déjà ne redémarre rien —
Kubernetes ne voit aucun changement. Le digest, lui, change à chaque
construction ; il règle du même coup l'`imagePullPolicy: IfNotPresent`, qui
garderait sinon l'ancienne image derrière un tag réutilisé. Il se lit après le
push :

```bash
docker buildx imagetools inspect registry.exemple.fr/cloudnord/hub:<version> \
  --format '{{.Manifest.Digest}}'
```

Ce chemin-là modifie le StatefulSet dans le cluster, pas les manifestes : un
`kubectl apply -k manifests/` ensuite le ramène à l'image du `newTag`.

## Ce qu'il faut régler avant

| Où | Quoi |
|---|---|
| `configmap.yaml` | `PUBLIC_URL`, l'adresse **publique** du hub, et `PROGRAM_SOURCE_URL` |
| `ingress.yaml` | l'hôte, la classe d'ingress, le secret TLS |
| `statefulset.yaml` | la `storageClassName` du `volumeClaimTemplates`, si le cluster n'en a pas de défaut |

`PUBLIC_URL` est la seule qu'on ne peut pas deviner à votre place : Better Auth
signe ses cookies avec, et l'adresse qu'un opérateur lit pour appairer une salle
en découle. Renseignée avec l'adresse du service au lieu de celle du navigateur,
l'appairage envoie les gens nulle part.

Puis créer un compte opérateur — l'inscription publique est fermée, et sans lui
la console est inaccessible :

```bash
kubectl -n conference-operator exec hub-0 -- \
  node --import tsx src/cli/operator.ts vous@exemple.fr "Régie" <mot-de-passe>
```

## Quatre contraintes, et leur raison

**Un StatefulSet, pas un Deployment.** Le hub porte une base SQLite : un pod qui
garde son nom (`hub-0`) et retrouve son volume, ce n'est pas un détail
d'esthétique, c'est ce que l'application est. Le volume est déclaré par
`volumeClaimTemplates` — Kubernetes crée la revendication `data-hub-0` et la
**garde** quand le StatefulSet disparaît ; la supprimer est un
`kubectl delete pvc` explicite, pas un effet de bord.

**Une seule réplique, et ce n'est pas un point de départ.** Le hub garde son état
dans un fichier SQLite et diffuse ses WebSockets en mémoire — une décision de ce
dépôt, qui supprime Redis et rend les tests exécutables sans conteneur. Monter à
deux répliques ne partagerait rien : chacune recevrait son propre volume, donc sa
propre base, et ne connaîtrait que ses propres salles. Deux hubs, pas un hub à
deux têtes.

**La mise à jour termine le pod avant de le recréer.** C'est le comportement du
`RollingUpdate` d'un StatefulSet à une réplique — il ne fait jamais se chevaucher
deux `hub-0` — et c'est ce qu'on veut : deux écrivains sur un fichier SQLite
n'arrivent donc pas. Ça coûte quelques secondes d'interruption à chaque
déploiement : c'est une chose à faire hors événement, pas une chose à rendre
concurrente.

**Le proxy doit laisser vivre les WebSockets.** Les salles reçoivent leurs
commandes et remontent leur état par `/ws`. Un ingress qui ferme les connexions
inactives au bout d'une minute donne des salles qui se reconnectent toute la
journée — ça se lit comme un réseau instable, c'est un délai d'expiration. Les
annotations fournies sont celles d'ingress-nginx ; avec un autre contrôleur, le
réglage change de nom, pas de nécessité.

## Migrer une installation déjà en service

Une installation antérieure a un `Deployment hub` et une revendication `hub-data`
écrite à la main. Le StatefulSet, lui, attend `data-hub-0`. Appliquer les
nouveaux manifestes sans rien faire d'autre **laisse la base derrière** : le
StatefulSet crée un volume vide et le hub repart sur une base neuve, sans
opérateurs ni appairages. Rien n'est perdu — `hub-data` reste là — mais le hub
qui tourne n'est plus celui qu'on croit.

La manœuvre garde le volume en place et se contente de le rattacher au nom que le
StatefulSet attend. **Sauvegarder `/data/hub.db` avant**, ne serait-ce que par
acquit de conscience.

```bash
kubectl -n conference-operator scale deploy/hub --replicas=0
kubectl -n conference-operator wait --for=delete pod \
  -l app.kubernetes.io/name=hub --timeout=2m

PV=$(kubectl -n conference-operator get pvc hub-data -o jsonpath='{.spec.volumeName}')
CLASS=$(kubectl -n conference-operator get pvc hub-data -o jsonpath='{.spec.storageClassName}')
SIZE=$(kubectl -n conference-operator get pvc hub-data -o jsonpath='{.status.capacity.storage}')

# Sans ça, supprimer la revendication supprime le volume avec.
kubectl patch pv "$PV" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

kubectl -n conference-operator delete deploy hub
kubectl -n conference-operator delete pvc hub-data
# Le volume garde la trace de son ancienne revendication : tant qu'elle est là,
# il reste « Released » et refuse de se lier à la nouvelle.
kubectl patch pv "$PV" -p '{"spec":{"claimRef":null}}'

# La revendication sous le nom qu'attend le StatefulSet, pointée sur ce volume.
# Elle doit exister *avant* lui, sinon il en crée une vide.
kubectl -n conference-operator apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-hub-0
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: $SIZE
  volumeName: $PV
  storageClassName: $CLASS
EOF

kubectl -n conference-operator get pvc data-hub-0   # attendu : Bound
kubectl apply -k manifests/
kubectl -n conference-operator logs hub-0 -f
```

Une fois le hub remonté et vérifié, remettre la politique d'origine si c'était
`Delete` :

```bash
kubectl patch pv "$PV" -p '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'
```

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
- **Agrandir le volume en modifiant ce fichier.** Le `volumeClaimTemplates` d'un
  StatefulSet n'est pas modifiable après coup : changer la taille ici ne fait
  rien sur une installation qui tourne, et `kubectl apply` le refuse. Agrandir se
  fait sur la revendication elle-même, si la classe de stockage l'autorise —
  `kubectl -n conference-operator patch pvc data-hub-0 -p
  '{"spec":{"resources":{"requests":{"storage":"5Gi"}}}}'` — puis en reportant le
  même chiffre ici pour que la prochaine installation naisse à la bonne taille.

## Une réserve

Ces manifestes ont été rendus (`kubectl kustomize manifests/`) et validés par un
`kubectl apply --dry-run=server` — l'API du cluster les accepte, webhooks
d'admission compris. Ils n'ont pas été **appliqués** pour autant, et la manœuvre
de migration ci-dessus n'a pas été jouée. Le premier déploiement mérite d'être
regardé :
`kubectl -n conference-operator logs hub-0 -f`, le temps que les migrations
passent et que le programme s'importe.
