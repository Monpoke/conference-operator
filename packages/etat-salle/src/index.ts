/**
 * L'automate d'une salle : où elle en est, et ce qu'on a le droit d'y faire.
 *
 * Deux automates, en réalité, et la distinction porte le reste :
 *
 * - `cycle-de-vie` est le seul état **stocké** — `scheduled → running → ended`,
 *   écrit par le hub sur décision d'un opérateur ou de la règle horaire ;
 * - `conference` est **calculé** : il croise le programme et ce cycle de vie
 *   pour dire, en un mot, où en est la salle. Rien ne le persiste, il se
 *   recalcule à chaque lecture.
 *
 * `apparence` traduit le second en couleur et en mot, pour que la console du
 * hub et la régie ne puissent plus décrire la même salle différemment.
 *
 * L'entrée `@cloudnord/etat-salle/navigateur` sert le sous-ensemble que les
 * pages sans build inlinent — voir `src/navigateur.ts`.
 */
export * from './conference.js'
export * from './cycle-de-vie.js'
export * from './apparence.js'
export { MACHINE_JS } from './generated/navigateur.js'
