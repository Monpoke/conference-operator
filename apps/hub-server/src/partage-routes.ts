import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Services } from './context.js'
import { partageContentSecurityPolicy, renderPartageLogin, renderPartagePage, type PartageVideoLine } from './pages/partage-page.js'
import { COOKIE, videosDuPartage } from './services/partages.js'

const COOKIE_DAYS = 30

/**
 * The shared pages: `/partage/<id>`, public, each behind its password.
 *
 * In a scope of their own: the form parser declared here must not reach the rest
 * of the hub, whose authentication reads its own bodies.
 */
export function partageRoutes(services: Services, publicUrl: string) {
  return async (app: FastifyInstance): Promise<void> => {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      done(null, new URLSearchParams(body as string))
    })

    const program = () => services.programs.active()?.program ?? null
    const titleOfPage = (sessionId: string | null): string => {
      if (sessionId == null) return `Vidéos — ${services.identity.get().name}`
      return program()?.sessions.find((session) => session.id === sessionId)?.title ?? 'Vidéo'
    }
    const videosOf = (sessionId: string | null) =>
      videosDuPartage(sessionId, services.montage.list(sessionId), services.partages.refuses())

    function html(reply: FastifyReply, status: number, body: string, videoOrigin: string | null = null): FastifyReply {
      return reply
        .status(status)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .header('x-robots-tag', 'noindex')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', partageContentSecurityPolicy(videoOrigin))
        .send(body)
    }

    function page(reply: FastifyReply, id: string, sessionId: string | null): FastifyReply {
      const jobs = videosOf(sessionId)
      const sessions = program()?.sessions ?? []
      const counts = new Map<string, number>()
      for (const job of jobs) counts.set(job.sessionId, (counts.get(job.sessionId) ?? 0) + 1)
      const seen = new Map<string, number>()
      const lines: PartageVideoLine[] = jobs.map((job) => {
        const session = sessions.find((candidate) => candidate.id === job.sessionId)
        const prise = (seen.get(job.sessionId) ?? 0) + 1
        seen.set(job.sessionId, prise)
        const title = job.title ?? session?.title ?? job.sessionId
        return {
          jobId: job.id,
          title: (counts.get(job.sessionId) ?? 1) > 1 ? `${title} (prise ${prise})` : title,
          detail: (session?.speakers ?? []).map((speaker) => speaker.name).join(', '),
        }
      })
      const first = jobs[0]
      return html(
        reply,
        200,
        renderPartagePage({ id, title: titleOfPage(sessionId), videos: lines }),
        first == null ? null : new URL(services.montage.downloadUrl(first.id, true)).origin,
      )
    }

    app.get('/partage/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const row = services.partages.get(request.params.id)
      if (row == null) return html(reply, 404, renderPartageLogin({ title: 'Page introuvable', erreur: 'Ce lien ne mène à aucune page, ou elle a été retirée.' }))
      if (services.partages.checkPass(row, request.headers.cookie)) return page(reply, row.id, row.sessionId)
      return html(reply, 200, renderPartageLogin({ title: titleOfPage(row.sessionId), erreur: null }))
    })

    app.post('/partage/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const row = services.partages.get(request.params.id)
      if (row == null) return reply.status(404).send()
      const title = titleOfPage(row.sessionId)
      // The bucket follows the address and the page: no guessing a password by trying again.
      if (!services.limiter.take(`partage:${row.id}:${request.ip}`)) {
        return html(reply, 429, renderPartageLogin({ title, erreur: 'Trop d’essais : réessayez dans une minute.' }))
      }
      const motDePasse = (request.body as URLSearchParams | undefined)?.get?.('motDePasse') ?? ''
      if (!services.partages.checkPassword(row, motDePasse)) {
        return html(reply, 401, renderPartageLogin({ title, erreur: 'Mot de passe incorrect.' }))
      }
      const secure = publicUrl.startsWith('https:') ? '; Secure' : ''
      return reply
        .header('set-cookie', `${COOKIE}=${services.partages.pass(row)}; Path=/partage/${row.id}; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86_400}${secure}`)
        .redirect(`/partage/${row.id}`, 303)
    })

    app.get('/partage/:id/video/:jobId', async (request: FastifyRequest<{ Params: { id: string; jobId: string }; Querystring: { telecharger?: string } }>, reply) => {
      const row = services.partages.get(request.params.id)
      if (row == null || !services.partages.checkPass(row, request.headers.cookie)) return reply.status(403).send()
      const job = videosOf(row.sessionId).find((candidate) => candidate.id === request.params.jobId)
      if (job == null) return reply.status(404).send()
      return reply
        .header('cache-control', 'no-store')
        .redirect(services.montage.downloadUrl(job.id, request.query.telecharger == null), 302)
    })
  }
}
