/**
 * Convention des messages de commit : Conventional Commits, en français.
 *
 * Le type et le scope servent à retrouver un changement des mois plus tard,
 * quand le contexte a disparu. Le reste de la convention — corps, `BREAKING
 * CHANGE`, `!` — vient de `config-conventional` et n'est pas redéfini ici.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    /*
     * 72 caractères, type et scope compris.
     *
     * `git log --oneline` ajoute le hachage court et un espace : au-delà, la
     * ligne se replie dans un terminal de 80 colonnes et la liste devient
     * illisible. Le défaut de `config-conventional` est à 100.
     */
    'header-max-length': [2, 'always', 72],
    /*
     * Les scopes sont fermés.
     *
     * Une liste ouverte donne `regie`, `régie`, `regie-web` et `Regie` sur
     * quatre commits qui touchent la même application : le scope ne sert plus
     * à filtrer. Les douze premiers sont les répertoires de `apps/` et
     * `packages/` — sous leur nom court quand il est sans ambiguïté.
     */
    'scope-enum': [
      2,
      'always',
      [
        'components',
        'console', // apps/hub-admin
        'contract',
        'db',
        'etat-salle',
        'format',
        'hub', // apps/hub-server
        'hub-client',
        'program',
        'regie', // apps/regie-web
        'room-client',
        'ui',
        'vod', // la chaîne de captation, qui traverse le hub, la salle et le contrat
        'deps',
        'dev', // scripts/dev-salles.sh, dev:trio, le proxy Vite
        'docker',
        'repo', // outillage, ignore, espace de travail
      ],
    ],
  },
}
