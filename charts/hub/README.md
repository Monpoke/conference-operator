# Le chart du hub

Les mêmes six ressources que `manifests/`, avec un fichier de values pour ce qui
change d'un déploiement à l'autre — au premier chef **les secrets**, qui tiennent
alors dans un fichier gardé hors du dépôt. Et, sur demande, le worker de montage
des VODs, branché sur le hub sans rien créer dans la console.

Chaque version est publiée sur GHCR, à côté de ses images, qu'elle épingle :

```bash
helm upgrade --install hub oci://ghcr.io/monpoke/conference-operator/charts/hub \
  --version X.Y.Z \
  --namespace conference-operator --create-namespace \
  -f ~/.config/conference-operator/hub-prod.yaml
```

Depuis le dépôt, pour un chart en cours de modification :

```bash
cp charts/hub/values.secrets.example.yaml ~/.config/conference-operator/hub-prod.yaml
$EDITOR ~/.config/conference-operator/hub-prod.yaml

helm upgrade --install hub charts/hub \
  --namespace conference-operator --create-namespace \
  -f ~/.config/conference-operator/hub-prod.yaml
```

`values.yaml` documente chaque réglage et la raison de ceux qui n'en sont pas.

## Le worker de montage

`montage.enabled: true` pose un Deployment `vod-montage` à côté du hub. Il
n'a de sens qu'avec le stockage S3 configuré : c'est là qu'il lit les rushes et
renvoie la vidéo montée.

Le hub et le worker partagent un jeton `wt_…`. Le hub le lit en
`MONTAGE_WORKER_TOKEN` et déclare au démarrage un « Worker du déploiement » qui
l'accepte ; le worker le présente en `HUB_WORKER_TOKEN`. Le montage tourne donc
dès la première installation, sans passer par la console.

| `montage.token` vide (défaut) | Le chart tire un jeton au premier `helm install`, le range dans le secret `hub-montage`, et le **relit** aux `upgrade` suivants : il ne change pas d'une mise à jour à l'autre. |
| `montage.token: wt_…` | Le jeton des values. En changer est une rotation : le hub et les workers redémarrent, l'ancien jeton n'ouvre plus rien. |
| `montage.existingSecret` | Un secret créé à la main, qui porte le jeton sous `montage.existingSecretKey`. Une rotation s'y fait à la main, suivie d'un redémarrage du hub et du worker. |

Ce worker apparaît dans la console (**VOD** → **Workers de montage**) mais ne
s'y révoque pas : la console le refuserait, puisque le redémarrage suivant le
rétablirait. On le retire en repassant `montage.enabled` à `false` — le hub,
sans la variable, le révoque à son démarrage et remet ses montages en file.

Pour monter plus de talks à la fois : `montage.replicas`. Les répliques
partagent le jeton, et donc une seule ligne dans la console ; chacune tient
son propre montage.

## Les secrets, et où ils finissent

Deux voies, exclusives :

| `secret.create: true` | Le chart rend le Secret à partir des values. Un fichier, une commande, tout est posé. **Helm archive chaque release dans un Secret du namespace, valeurs comprises** : qui peut lire les releases peut lire vos clés. |
| `secret.existingSecret: hub` | Le chart monte un secret créé à la main et n'en gère aucun. Rien de sensible ne transite par Helm ni par l'historique des releases. |

La seconde est la bonne pour un vrai déploiement ; la première est celle qui
rend le fichier de values utile. Le choix est le vôtre, il n'est pas neutre.

```bash
kubectl -n conference-operator create secret generic hub \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 48)"
```

## Ce que le chart refuse de rendre

Les règles que `apps/hub-server/src/config.ts` applique au démarrage sont
rejouées au rendu (`templates/_validate.tpl`) : le `BETTER_AUTH_SECRET` et sa
longueur, la paire Google et son domaine obligatoire, le trio S3. Le hub refuse
déjà de démarrer sur une configuration à moitié faite — les redire ici avance
l'échec du `CrashLoopBackOff` qu'il faut aller lire dans les logs au terminal de
qui lance `helm upgrade`. `config.publicUrl` et `ingress.host` sont refusés tant
qu'ils portent leur exemple.

C'est un doublon, à tenir à jour avec les `refine` du schéma. Il n'y en a que
trois, et ce sont ceux qui coûtent une soirée quand ils se découvrent tard.

## Poser une image construite localement

`REGISTRY=… pnpm build:local k8s` continue de fonctionner tel quel : il patche
le StatefulSet avec le digest poussé, sans passer par Helm. Le `helm upgrade`
suivant ramènera l'image des values — c'est le même rapport qu'entre ce script
et `kubectl apply -k`. Pour que le digest survive, il va dans les values :

```bash
helm upgrade hub charts/hub -f ~/….yaml \
  --set image.digest=sha256:… --reuse-values
```

## Reprendre une installation posée par kustomize

Helm refuse d'adopter des ressources qu'il ne connaît pas : `helm install` sur un
namespace où `kubectl apply -k manifests/` est déjà passé échoue en annonçant
qu'elles existent et n'ont pas de propriétaire. Il faut les lui attribuer.

**Vérifier d'abord que le chart rend bien ce qui tourne**, avec vos values :

```bash
helm template hub charts/hub -n conference-operator -f ~/….yaml > /tmp/rendu.yaml
kubectl -n conference-operator diff -f /tmp/rendu.yaml
```

Hors des étiquettes que Helm ajoute et de l'annotation `checksum/config`, ce diff
doit être vide. Puis :

```bash
for kind_name in configmap/hub secret/hub service/hub service/hub-headless \
                 statefulset/hub ingress/hub; do
  kubectl -n conference-operator annotate --overwrite "$kind_name" \
    meta.helm.sh/release-name=hub meta.helm.sh/release-namespace=conference-operator
  kubectl -n conference-operator label --overwrite "$kind_name" \
    app.kubernetes.io/managed-by=Helm
done

helm upgrade --install hub charts/hub -n conference-operator -f ~/….yaml
```

Le PVC `data-hub-0` n'est pas dans la liste : il est créé par le
`volumeClaimTemplates` du StatefulSet, pas par le chart, et Helm n'y touche
jamais — y compris à la désinstallation.

## Deux pièges rencontrés en vrai

**Un pod en échec bloque toute mise à jour.** Un StatefulSet ne remplace un pod
qu'après l'avoir vu `Running and Ready` : un `hub-0` coincé en
`ImagePullBackOff` ou `CrashLoopBackOff` ne partira pas, et `helm upgrade` — comme
`kubectl set image` — patchera la spécification sans que rien ne bouge. Le
débloquer est un geste explicite : `kubectl delete pod hub-0`.

**Helm fusionne les maps.** `ingress.annotations` est donc vide par défaut : une
annotation d'ingress-nginx posée là s'ajouterait à la vôtre au lieu d'être
remplacée, et atterrirait sur un ingress traefik. Les deux jeux sont donnés en
commentaire dans `values.yaml` — le point qu'ils font, laisser vivre les
WebSockets de `/ws`, doit être fait quel que soit le contrôleur.

## Après l'installation

L'inscription publique est fermée : il faut un premier administrateur. Deux
voies n'y demandent rien de plus que les values :

- **`secret.initialAdmin`** (adresse et mot de passe) : le hub crée ce compte au
  démarrage, **s'il n'a encore aucun compte**. Ensuite la valeur est ignorée —
  un mot de passe changé dans la console n'est pas remis au redémarrage suivant.
- **Google Workspace** : sur un hub sans compte, le premier à se connecter
  devient administrateur. Les suivants arrivent en lecture seule, jusqu'à ce
  qu'il les élève (console → **Accès**).

Avec l'un et l'autre, `initialAdmin` passe en premier : la connexion Google qui
suit n'est plus la première.

À défaut, la commande `operator`, dans le conteneur. L'image est distroless,
d'où le chemin complet vers `node`, que `kubectl exec` ne prend pas de
l'`ENTRYPOINT` :

```bash
kubectl -n conference-operator exec hub-0 -- \
  /nodejs/bin/node --import tsx src/cli/operator.ts \
  vous@exemple.fr "Régie" '<mot-de-passe>' --role admin
```
