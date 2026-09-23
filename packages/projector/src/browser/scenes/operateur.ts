import type { Session } from '@conference-operator/program'
import type { Data, Scene } from '../scene.js'
import { cree, ecrire, svg } from '../dom.js'
import { heureDans, maintenant } from '../time.js'

/*
 * The screens the operator puts up from the control room, drawn in the loop's
 * theme. Unlike the loop's scenes, they follow their data in place — a question
 * replaced, a message corrected — since the operator chose to show them now.
 */

/** Effective end of a slot: its end, its duration, or the next slot's start. */
function finEffective(sessions: Session[], index: number): number | null {
  const s = sessions[index]
  if (s == null) return null
  if (s.endsAtMs != null) return s.endsAtMs
  if (s.durationMinutes != null) return s.startsAtMs + s.durationMinutes * 60_000
  return sessions[index + 1]?.startsAtMs ?? null
}

/**
 * The room's program, one column, walking round the day on its own: running
 * slot, end of the day, start, running slot — a projector cannot be scrolled.
 */
export function programme(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande">
      <div class="bande-titre">
        <h2 class="f-titre" data-titre data-effet="mots"></h2>
        <span class="pastille pastille-ici" data-effet="pop" data-delai="500">Vous êtes ici</span>
      </div>
      <p class="bande-droite" data-horloge>--:--</p>
    </header>
    <div class="contenu scroller"><ol class="programme-liste" data-effet-enfants="entre" data-cible=".seance" data-pas="40" data-delai="200"></ol></div>
    <p class="vide" hidden>Programme indisponible</p>`
  const titre = el.querySelector<HTMLElement>('[data-titre]')!
  const horloge = el.querySelector<HTMLElement>('[data-horloge]')!
  const cadre = el.querySelector<HTMLElement>('.scroller')!
  const liste = el.querySelector<HTMLElement>('.programme-liste')!
  const vide = el.querySelector<HTMLElement>('.vide')!

  /** Sets the round trip going; the duration follows the height left to travel. */
  function cycle(): void {
    liste.classList.remove('cycling')
    const hauteur = cadre.clientHeight
    const course = liste.scrollHeight - hauteur
    const ancre = liste.querySelector<HTMLElement>('.anchor')
    // Where nothing measures, the running slot is at least brought to the centre.
    ancre?.scrollIntoView?.({ block: 'center' })
    if (!(course > 0)) return
    const vise = ancre ? ancre.offsetTop - (hauteur - ancre.offsetHeight) / 2 : 0
    const depart = Math.max(0, Math.min(vise, course))
    cadre.scrollTop = 0
    liste.style.setProperty('--from', `${-depart}px`)
    liste.style.setProperty('--end', `${-course}px`)
    liste.style.animationDuration = `${Math.round((course / hauteur) * 22_000 + 12_000)}ms`
    liste.classList.add('cycling')
  }

  return {
    el,
    cle: (data: Data) => [data.sessions, data.roomName, data.state.currentSession?.id, data.state.nextSession?.id],
    jouable: () => true,
    vide: 'Programme indisponible',
    rendre(data: Data) {
      ecrire(titre, data.roomName ?? '')
      const now = maintenant(data)
      const running = data.state.currentSession?.id
      const anchor = running ?? data.state.nextSession?.id
      vide.hidden = data.sessions.length > 0
      liste.replaceChildren(...data.sessions.map((s, index) => {
        const end = finEffective(data.sessions, index)
        const classes = ['seance']
        // A shared slot — breakfast, lunch, coffee — and not any slot without a
        // speaker: the opening keynote has none, and is no break.
        const pause = s.kind === 'break' && ((s.roomSpan ?? 1) > 1 || s.sharedFrom != null)
        if (pause) classes.push('est-pause')
        if (s.id === running) classes.push('est-encours')
        else if (end != null && end < now) classes.push('est-passee')
        if (s.id === anchor) classes.push('anchor')
        const li = cree('li', classes.join(' '))
        const heure = cree('div', 'seance-heure')
        heure.append(cree('strong', null, heureDans(s.startsAtMs, data.timezone)))
        if (end != null) heure.append(cree('span', null, heureDans(end, data.timezone)))
        const corps = cree('div', 'seance-corps')
        corps.append(cree('p', 'seance-titre', s.title))
        const qui = s.speakers.map((p) => (p.company ? `${p.name} (${p.company})` : p.name)).join(', ')
        if (qui) corps.append(cree('p', 'seance-meta', qui))
        li.append(heure, corps)
        return li
      }))
      cycle()
    },
    tick(data: Data, now: number) {
      horloge.textContent = heureDans(now, data.timezone)
    },
  }
}

/** Until the next talk: the minutes and seconds, large, in the title face. */
export function decompte(el: HTMLElement): Scene {
  el.innerHTML = `
    <div class="decompte">
      <p class="decompte-titre f-titre contour" data-effet="mots">Reprise dans</p>
      <p class="decompte-chiffres f-titre contour"><span class="cd-min">--</span>:<span class="cd-sec">--</span></p>
      <p class="decompte-reprise" data-effet="glisse" data-delai="300"></p>
    </div>`
  const titre = el.querySelector<HTMLElement>('.decompte-titre')!
  const chiffres = el.querySelector<HTMLElement>('.decompte-chiffres')!
  const min = el.querySelector<HTMLElement>('.cd-min')!
  const sec = el.querySelector<HTMLElement>('.cd-sec')!
  const reprise = el.querySelector<HTMLElement>('.decompte-reprise')!
  let derniere: number | null = null
  return {
    el,
    cle: (data: Data) => data.state.nextSession?.id ?? null,
    jouable: () => true,
    rendre(data: Data) {
      const next = data.state.nextSession
      chiffres.hidden = next == null
      ecrire(titre, next ? 'Reprise dans' : 'Fin des interventions')
      ecrire(reprise, next ? `Reprise — ${next.title}` : '')
    },
    tick(data: Data, now: number) {
      const next = data.state.nextSession
      if (next == null) return
      const reste = Math.max(0, next.startsAtMs - now)
      const secondes = Math.floor((reste % 60000) / 1000)
      min.textContent = String(Math.floor(reste / 60000)).padStart(2, '0')
      sec.textContent = String(secondes).padStart(2, '0')
      chiffres.dataset.texte = chiffres.textContent ?? ''
      if (secondes !== derniere) {
        derniere = secondes
        chiffres.classList.remove('beat')
        void chiffres.offsetWidth
        chiffres.classList.add('beat')
      }
    },
  }
}

/** The console's message, full screen, in the animated-message style. */
export function banniere(el: HTMLElement): Scene {
  el.innerHTML = `
    <div class="message">
      <p class="message-texte f-titre contour vague" data-effet="claque"></p>
    </div>`
  const cadre = el.querySelector<HTMLElement>('.message')!
  const texte = el.querySelector<HTMLElement>('.message-texte')!
  return {
    el,
    cle: (data: Data) => data.state.message,
    jouable: () => true,
    rendre(data: Data) {
      const m = data.state.message
      cadre.classList.toggle('urgent', m?.level === 'urgent')
      cadre.classList.toggle('warning', m?.level === 'warning')
      ecrire(texte, m?.text ?? '—')
    },
  }
}

/** The running talk's OpenFeedback QR, while the audience is still seated. */
export function avis(el: HTMLElement): Scene {
  el.innerHTML = `
    <div class="avis">
      <div class="cadre-qr respire" data-effet="pop" data-delai="300">
        <svg viewBox="0 0 100 100" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"><path d="M3 28V13Q3 3 13 3H28M72 3H87Q97 3 97 13V28M97 72V87Q97 97 87 97H72M28 97H13Q3 97 3 87V72"/></svg>
        <div class="qr"></div>
      </div>
      <div>
        <h2 class="avis-titre f-titre contour" data-effet="mots">Votre avis sur cette conférence</h2>
        <p class="avis-talk" data-effet="glisse" data-delai="400"></p>
        <p class="avis-aide" data-effet="glisse" data-delai="600">Scannez pour noter la conférence et laisser un commentaire aux speakers.</p>
      </div>
    </div>
    <p class="vide" hidden>Aucune conférence à noter</p>`
  const cadre = el.querySelector<HTMLElement>('.avis')!
  const qr = el.querySelector<HTMLElement>('.qr')!
  const talk = el.querySelector<HTMLElement>('.avis-talk')!
  const vide = el.querySelector<HTMLElement>('.vide')!
  return {
    el,
    cle: (data: Data) => [data.feedback, data.state.currentSession?.title],
    jouable: () => true,
    rendre(data: Data) {
      const node = data.feedback?.qrSvg ? svg(data.feedback.qrSvg) : null
      cadre.hidden = node == null
      vide.hidden = node != null
      qr.replaceChildren(...(node ? [node] : []))
      ecrire(talk, data.state.currentSession?.title ?? '')
    },
  }
}

/** An audience question chosen in the control app, on the conduct panel. */
export function question(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande"><h2 class="f-titre" data-effet="mots">Question du public</h2></header>
    <div class="question" data-effet="balayage" data-delai="250">
      <p class="question-texte contour"></p>
      <p class="question-auteur"></p>
    </div>
    <p class="vide" hidden>Aucune question affichée</p>`
  const panneau = el.querySelector<HTMLElement>('.question')!
  const texte = el.querySelector<HTMLElement>('.question-texte')!
  const auteur = el.querySelector<HTMLElement>('.question-auteur')!
  const vide = el.querySelector<HTMLElement>('.vide')!
  return {
    el,
    cle: (data: Data) => data.state.question,
    jouable: () => true,
    rendre(data: Data) {
      const q = data.state.question
      panneau.hidden = q == null
      vide.hidden = q != null
      ecrire(texte, q?.text ?? '')
      ecrire(auteur, q?.author ?? '')
      auteur.hidden = !q?.author
    },
  }
}

/** The hub's moderated wall: the latest messages, and the QR to write one. */
export function murHub(el: HTMLElement): Scene {
  el.innerHTML = `
    <header class="bande"><h2 class="f-titre" data-effet="mots">Vos messages</h2></header>
    <div class="contenu mur-hub">
      <div class="mur-hub-liste" data-effet-enfants="entre" data-cible=".carte" data-pas="90" data-delai="200"></div>
      <div class="mur-hub-qr" data-effet="pop" data-delai="400">
        <div class="cadre-qr"><svg viewBox="0 0 100 100" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"><path d="M3 28V13Q3 3 13 3H28M72 3H87Q97 3 97 13V28M97 72V87Q97 97 87 97H72M28 97H13Q3 97 3 87V72"/></svg><div class="qr"></div></div>
        <p>Scannez pour laisser un message ou poser une question</p>
      </div>
    </div>`
  const liste = el.querySelector<HTMLElement>('.mur-hub-liste')!
  const colonne = el.querySelector<HTMLElement>('.mur-hub-qr')!
  const qr = el.querySelector<HTMLElement>('.qr')!
  return {
    el,
    cle: (data: Data) => [data.state.comments, data.wall?.qrSvg],
    jouable: () => true,
    rendre(data: Data) {
      const messages = data.state.comments
      const node = data.wall?.qrSvg ? svg(data.wall.qrSvg) : null
      colonne.hidden = node == null
      qr.replaceChildren(...(node ? [node] : []))
      liste.replaceChildren(...(messages.length === 0
        // The wall can be empty at the start of the day: better to invite than to
        // leave a deserted frame.
        ? [Object.assign(cree('article', 'carte'), { textContent: 'Les premiers messages apparaîtront ici.' })]
        : messages.map((m) => {
            const carte = cree('article', 'carte')
            carte.append(cree('p', 'carte-nom', m.author), cree('p', 'carte-texte', m.text))
            return carte
          })))
    },
  }
}

/** On air: nothing — the stage goes black and the video speaks. */
export function direct(el: HTMLElement): Scene {
  return { el, cle: () => null, jouable: () => true, rendre() {} }
}
