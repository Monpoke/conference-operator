# Le chart du hub

Les mêmes six ressources que `manifests/`, avec un fichier de values pour ce qui
change d'un déploiement à l'autre — au premier chef **les secrets**, qui tiennent
alors dans un fichier gardé hors du dépôt.

```bash
cp charts/hub/values.secrets.example.yaml ~/.config/conference-operator/hub-prod.yaml
$EDITOR ~/.config/conference-operator/hub-prod.yaml

helm upgrade --install hub charts/hub \
  --namespace conference-operator --create-namespace \
  -f ~/.config/conference-operator/hub-prod.yaml
```

`values.yaml` documente chaque réglage et la raison de ceux qui n'en sont pas.

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

L'inscription publique est fermée : sans compte opérateur, la console est
inaccessible. L'image est distroless, d'où le chemin complet vers `node`, que
`kubectl exec` ne prend pas de l'`ENTRYPOINT` :

```bash
kubectl -n conference-operator exec hub-0 -- \
  /nodejs/bin/node --import tsx src/cli/operator.ts \
  vous@exemple.fr "Régie" '<mot-de-passe>' --role admin
```
