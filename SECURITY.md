# Politique de sécurité

## Signaler une faille

**N'ouvrez pas de ticket public.** Un ticket est indexé dans la minute, et ce
logiciel tourne pendant l'événement : le temps de publier un correctif, la
faille serait exploitable par quiconque a lu le ticket.

Deux voies privées :

- l'onglet **Security → Report a vulnerability** de ce dépôt (GitHub Private
  Vulnerability Reporting), qui est la voie à privilégier ;
- à défaut, par courriel à `<adresse à compléter>`.

Merci d'inclure : ce que vous avez obtenu, comment le reproduire, la version ou
le commit concerné. Une réponse vous parviendra sous une semaine.

## Ce qui est dans le périmètre

Ce dépôt manipule des éléments qui méritent une attention particulière :

- **le secret Better Auth** (`BETTER_AUTH_SECRET`) et les sessions opérateur du
  hub ;
- **l'appairage des machines de salle** — le mécanisme qui décide qu'un poste a
  le droit de recevoir le programme et d'émettre des commandes ;
- **les mots de passe OBS**, stockés par le hub et poussés aux salles. Ils ne
  doivent jamais redescendre jusqu'à une page servie ; un test le vérifie, et
  toute régression sur ce point est une faille ;
- **les pages publiques** — mur des messages et questions du public — qui
  acceptent du texte de n'importe qui et l'affichent devant une salle, puis
  dans une captation destinée à la VOD ;
- **le serveur local de la salle**, qui écoute sur le réseau de l'événement.

## Ce qui n'en fait pas partie

- Les mots de passe et secrets présents dans les tests (`motdepasse-regie-2026`,
  `test-secret-…`) : ce sont des fixtures, ils ne donnent accès à rien.
- Une console d'administration accessible à quelqu'un qui a déjà les
  identifiants d'un opérateur : c'est le comportement attendu.
- Les dépendances tierces — signalez-les à leurs auteurs. Si l'une d'elles nous
  expose, dites-le nous quand même.

## Ce que le projet ne promet pas

Il n'y a pas de version supportée à long terme : le dépôt suit une édition de
l'événement. Les correctifs de sécurité sont appliqués sur `main`.
