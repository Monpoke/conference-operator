/**
 * Commit message convention: Conventional Commits, written in French.
 *
 * The type and the scope are what let a change be found again months later, once
 * the context is gone. The rest of the convention — body, `BREAKING CHANGE`, `!`
 * — comes from `config-conventional` and is not redefined here.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    /*
     * 72 characters, type and scope included.
     *
     * `git log --oneline` adds the short hash and a space: beyond that, the line
     * wraps in an 80-column terminal and the list becomes unreadable. The
     * `config-conventional` default is 100.
     */
    'header-max-length': [2, 'always', 72],
    /*
     * The scopes are a closed list.
     *
     * An open list yields `control`, `contrôle`, `control-web` and `Control` on
     * four commits touching the same application: the scope no longer filters
     * anything. The first twelve are the directories of `apps/` and `packages/` —
     * under their short name where that is unambiguous.
     */
    'scope-enum': [
      2,
      'always',
      [
        'components',
        'console', // apps/hub-admin
        'contract',
        'db',
        'room-state',
        'format',
        'hub', // apps/hub-server
        'hub-client',
        'program',
        'control', // apps/control-web
        'room-client',
        'ui',
        'vod', // the recording chain, spanning the hub, the room and the contract
        'deps',
        'dev', // scripts/dev-rooms.sh, dev:trio, the Vite proxy
        'docker',
        'repo', // tooling, ignore files, workspace
      ],
    ],
  },
}
