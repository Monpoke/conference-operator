# Thèmes et contenu de la boucle

Un **thème** habille les écrans de salle, l'habillage de captation et l'intro/outro des
VOD : couleurs, polices, décor. Le **contenu** (textes, annonces, pages sponsors…) se
règle dans la console, vue Boucle. Les deux peuvent venir d'un dossier, importé :

- en `.zip` depuis la console (panneau « Thème ») — le thème seul ;
- depuis un dépôt Git (panneau « Dépôt Git ») : une branche, un sous-dossier, un jeton
  d'accès si le dépôt est privé. Thème et contenu s'y importent chacun par son bouton,
  à la demande : rien ne se synchronise tout seul.

Sans thème choisi, les écrans portent le thème par défaut, intégré au code.

## Un dossier

```
theme.json      le thème : identifiant, couleurs, polices, décor (voir cloudnord/)
decor.svg       le décor derrière les scènes, 1920×1080 (facultatif)
theme.css       des règles propres au thème (facultatif)
fonts/          les polices qu'il déclare, et leur licence
images/         les images de son CSS, de son décor — et du contenu
boucle.json     le contenu de la boucle (facultatif, dépôt Git seulement)
```

`cloudnord/` est le thème de Cloud Nord : un exemple complet. `pnpm theme:pack
themes/cloudnord` en fait le `.zip` importable ; le hub le connaît déjà, il l'amorce au
démarrage.

Ce qu'un paquet ne peut pas contenir : rien qui vienne d'ailleurs (`@import`, adresse
http dans le CSS ou le SVG), ni script, ni gestionnaire d'événement — les salles
projettent hors-ligne, et ce qui est projeté est enregistré. Le hub refuse un paquet
fautif en listant toutes ses raisons.

## `boucle.json`

Les sections de la boucle, sous les noms de la console (`accueil`, `messages`,
`annonces`, `sponsorPages`, `merciSponsors`, `conduite`, `feedbacks`…). Le plus simple
pour commencer : « Exporter le contenu » dans le panneau « Dépôt Git », qui écrit celui
du hub.

À l'import, **les sections présentes remplacent celles du hub, les autres restent** ;
tout reste modifiable dans la console ensuite, jusqu'au prochain import. Un `logo` peut
être un chemin du dossier (`images/sponsor.png`) : le hub le dépose comme une image
envoyée depuis la console. Le thème choisi et le lien public d'aperçu ne viennent jamais
d'un fichier.
