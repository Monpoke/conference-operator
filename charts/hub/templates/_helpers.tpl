{{/*
Le nom des ressources.

Volontairement `hub` tout court, et non le `<release>-<chart>` de la convention
Helm : ce sont les noms que portent déjà les manifestes kustomize et le secret
créé à la main, et les garder est ce qui permet d'adopter une installation
existante sans rien renommer. Le sélecteur d'un StatefulSet étant immuable, un
nom différent voudrait dire supprimer la charge de travail pour la recréer.
*/}}
{{- define "hub.name" -}}
{{- default "hub" .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hub.labels" -}}
app.kubernetes.io/name: {{ include "hub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{/*
Le sélecteur, et lui seul.

Une seule étiquette, celle des manifestes d'origine. Y ajouter
`app.kubernetes.io/instance` serait plus conforme à l'usage Helm et rendrait le
chart ininstallable sur une installation existante : le `selector` d'un
StatefulSet ne se modifie pas.
*/}}
{{- define "hub.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hub.name" . }}
{{- end -}}

{{/*
L'image : le digest s'il est là, le tag sinon.

Le digest l'emporte parce que c'est la forme qui désigne une construction
précise — c'est ce que pose `build:local k8s`, et ce qui règle le cas d'une
`imagePullPolicy: IfNotPresent` devant un tag réutilisé.
*/}}
{{- define "hub.image" -}}
{{- $repo := .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repo .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/*
Le nom du secret monté par `envFrom` : celui qu'on fournit, ou celui qu'on rend.
*/}}
{{- define "hub.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- include "hub.name" . -}}
{{- end -}}
{{- end -}}
