import type { Data, Scene } from '../scene.js'
import { cree, ecrire, svg } from '../dom.js'

/** The reference's rounded QR frame, with a QR drawn by the room inside. */
const CADRE = `<svg viewBox="0 0 100 100" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round">
  <path d="M3 28V13Q3 3 13 3H28M72 3H87Q97 3 97 13V28M97 72V87Q97 97 87 97H72M28 97H13Q3 97 3 87V72"/>
</svg>`

function poserQr(cadre: HTMLElement, markup: string | null): void {
  const qr = cadre.querySelector<HTMLElement>('.qr')!
  const node = markup ? svg(markup) : null
  qr.replaceChildren(...(node ? [node] : []))
  cadre.style.visibility = node ? 'visible' : 'hidden'
}

/** The code of conduct: its paragraphs on a translucent panel, the QR, the slogan. */
export function conduite(el: HTMLElement): Scene {
  el.innerHTML = `
    <div class="cc-panneau"></div>
    <div class="cc-qr">
      <p class="cc-legende" data-effet="machine" data-delai="1000"></p>
      <div class="cadre-qr respire" data-effet="pop" data-delai="1150">${CADRE}<div class="qr"></div></div>
    </div>
    <div class="slogan cc-slogan">
      <p class="slogan-creux" data-effet="tampon" data-delai="1400"></p>
      <p class="slogan-orange contour respire" data-effet="tampon" data-delai="1600"></p>
    </div>`
  const panneau = el.querySelector<HTMLElement>('.cc-panneau')!
  const legende = el.querySelector<HTMLElement>('.cc-legende')!
  const cadre = el.querySelector<HTMLElement>('.cadre-qr')!
  const creux = el.querySelector<HTMLElement>('.slogan-creux')!
  const orange = el.querySelector<HTMLElement>('.slogan-orange')!
  return {
    el,
    cle: (data: Data) => data.boucle?.conduite ?? null,
    jouable: (data: Data) => (data.boucle?.conduite.paragraphes.length ?? 0) > 0,
    rendre(data: Data) {
      const c = data.boucle?.conduite
      panneau.replaceChildren(...(c?.paragraphes ?? []).map((texte, i) => {
        const p = cree('p', 'contour', texte)
        p.dataset.texte = texte
        p.dataset.effet = 'balayage'
        if (i) p.dataset.delai = String(i * 350)
        return p
      }))
      ecrire(legende, c?.qrSvg ? c.legende : '')
      poserQr(cadre, c?.qrSvg ?? null)
      ecrire(creux, c?.slogan.creux ?? '')
      ecrire(orange, c?.slogan.orange ?? '')
    },
  }
}

/** "Pensez à donner vos feedbacks", the event's QR, "Merci beaucoup !". */
export function feedbacks(el: HTMLElement): Scene {
  el.innerHTML = `
    <div class="slogan fb-slogan">
      <p class="slogan-creux" data-effet="tampon"></p>
      <p class="slogan-orange contour respire" data-effet="tampon" data-delai="200"></p>
    </div>
    <div class="fb-qr cadre-qr respire" data-effet="pop" data-delai="450">${CADRE}<div class="qr"></div></div>
    <p class="fb-merci"><span class="balance" data-effet="ecriture" data-delai="800"></span><span class="balance" style="--i:1" data-effet="ecriture" data-delai="1350"></span></p>`
  const creux = el.querySelector<HTMLElement>('.slogan-creux')!
  const orange = el.querySelector<HTMLElement>('.slogan-orange')!
  const cadre = el.querySelector<HTMLElement>('.fb-qr')!
  const [merci1, merci2] = [...el.querySelectorAll<HTMLElement>('.fb-merci span')] as [HTMLElement, HTMLElement]
  return {
    el,
    cle: (data: Data) => data.boucle?.feedbacks ?? null,
    // Asking for feedback with nowhere to give it would be a dead end.
    jouable: (data: Data) => Boolean(data.boucle?.feedbacks.qrSvg),
    rendre(data: Data) {
      const f = data.boucle?.feedbacks
      ecrire(creux, f?.slogan.creux ?? '')
      ecrire(orange, f?.slogan.orange ?? '')
      poserQr(cadre, f?.qrSvg ?? null)
      ecrire(merci1, f?.merci[0] ?? '')
      ecrire(merci2, f?.merci[1] ?? '')
    },
  }
}
