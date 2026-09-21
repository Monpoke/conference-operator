{{/*
Les règles que `apps/hub-server/src/config.ts` fait respecter au démarrage,
rejouées au rendu.

Le hub refuse déjà de démarrer sur une configuration à moitié faite — c'est une
décision assumée : l'échec doit arriver au déploiement, pas dans la salle. Les
redire ici les avance encore d'un cran, du `CrashLoopBackOff` qu'il faut aller
lire dans les logs à un message sur le terminal de qui lance `helm upgrade`.

Ce doublon est à tenir à jour avec les `refine` du schéma. Il n'y en a que trois,
et ce sont ceux qui coûtent une soirée quand ils se découvrent tard.
*/}}
{{- define "hub.validate" -}}

{{- if and .Values.secret.existingSecret .Values.secret.create -}}
{{- fail "secret.existingSecret et secret.create s'excluent : monter un secret existant ou en rendre un, pas les deux. Posez secret.create=false." -}}
{{- end -}}

{{- if not (or .Values.secret.existingSecret .Values.secret.create) -}}
{{- fail "Aucun secret : renseignez secret.existingSecret, ou laissez secret.create à true avec secret.betterAuthSecret. Le hub ne démarre pas sans BETTER_AUTH_SECRET." -}}
{{- end -}}

{{- if .Values.secret.create -}}
  {{- if not .Values.secret.betterAuthSecret -}}
  {{- fail "secret.betterAuthSecret est requis : openssl rand -base64 48" -}}
  {{- end -}}
  {{- if lt (len .Values.secret.betterAuthSecret) 32 -}}
  {{- fail "secret.betterAuthSecret doit faire au moins 32 caractères (BETTER_AUTH_SECRET)." -}}
  {{- end -}}

  {{/* Google : les deux identifiants par paire, et le domaine obligatoire avec. */}}
  {{- $google := .Values.secret.google -}}
  {{- if not (eq (empty $google.clientId) (empty $google.clientSecret)) -}}
  {{- fail "secret.google.clientId et secret.google.clientSecret vont par paire : les deux, ou aucun." -}}
  {{- end -}}
  {{- if and $google.clientId (not $google.hostedDomain) -}}
  {{- fail "secret.google.hostedDomain est obligatoire avec un clientId : il décide qui est opérateur, tout compte du domaine en étant un." -}}
  {{- end -}}

{{- end -}}

{{/*
S3 : trois réglages qui vont ensemble, et qui sont à cheval sur les deux
ressources — l'adresse n'est pas un secret, les clés le sont.

Vérifiable seulement quand le chart rend lui-même le secret. Avec
`secret.existingSecret`, il ne voit pas les clés et ne peut rien dire : c'est le
hub qui refusera de démarrer, comme avant, et le message sera dans ses logs.
*/}}
{{- if .Values.secret.create -}}
{{- $set := 0 -}}
{{- range list .Values.config.s3.endpoint .Values.secret.s3.accessKeyId .Values.secret.s3.secretAccessKey -}}
{{- if . }}{{ $set = add1 $set }}{{ end -}}
{{- end -}}
{{- if and (ne $set 0) (ne $set 3) -}}
{{- fail "S3 : config.s3.endpoint, secret.s3.accessKeyId et secret.s3.secretAccessKey vont ensemble — les trois, ou aucun. Autrement le hub monte une console qui annonce un stockage où chaque téléversement échoue à la signature." -}}
{{- end -}}
{{- end -}}

{{- if or (not .Values.config.publicUrl) (eq .Values.config.publicUrl "https://hub.exemple.fr") -}}
{{- fail "config.publicUrl porte encore l'exemple. C'est l'adresse qu'un navigateur voit : Better Auth signe ses cookies avec, et l'appairage des salles en découle." -}}
{{- end -}}

{{- if .Values.ingress.enabled -}}
  {{- if or (not .Values.ingress.host) (eq .Values.ingress.host "hub.exemple.fr") -}}
  {{- fail "ingress.host porte encore l'exemple (ou ingress.enabled=false si le hub n'est pas exposé par un ingress)." -}}
  {{- end -}}
{{- end -}}

{{- end -}}
