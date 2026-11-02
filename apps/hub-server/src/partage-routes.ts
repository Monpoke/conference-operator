import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Services } from './context.js'
import { partageContentSecurityPolicy, renderPartageLecteur, renderPartageLogin, renderPartagePage, type PartageVideoLine } from './pages/partage-page.js'
import { COOKIE, lignesVideos, videosDuPartage } from './services/partages.js'

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

    const lines = (sessionId: string | null): PartageVideoLine[] => lignesVideos(videosOf(sessionId))

    /** The password checked, the visitor let in: the address comes back clean, the password out of it. */
    function attempt(request: FastifyRequest, reply: FastifyReply, row: NonNullable<ReturnType<Services['partages']['get']>>, motDePasse: string): FastifyReply {
      const title = titleOfPage(row.sessionId)
      // The bucket follows the address and the page: no guessing a password by trying again.
      if (!services.limiter.take(`partage:${row.id}:${request.ip}`)) {
        return html(reply, 429, renderPartageLogin({ title, erreur: 'Trop d’essais : réessayez dans une minute.' }))
      }
      if (!services.partages.checkPassword(row, motDePasse)) {
        return html(reply, 401, renderPartageLogin({ title, erreur: 'Mot de passe incorrect.' }))
      }
      const secure = publicUrl.startsWith('https:') ? '; Secure' : ''
      return reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .header('set-cookie', `${COOKIE}=${services.partages.pass(row)}; Path=/partage/${row.id}; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86_400}${secure}`)
        .redirect(`/partage/${row.id}`, 303)
    }

    app.get('/partage/:id', async (request: FastifyRequest<{ Params: { id: string }; Querystring: { mdp?: string } }>, reply) => {
      const row = services.partages.get(request.params.id)
      if (row == null) return html(reply, 404, renderPartageLogin({ title: 'Page introuvable', erreur: 'Ce lien ne mène à aucune page, ou elle a été retirée.' }))
      if (request.query.mdp != null) return attempt(request, reply, row, request.query.mdp)
      if (services.partages.checkPass(row, request.headers.cookie)) {
        return html(reply, 200, renderPartagePage({ id: row.id, title: titleOfPage(row.sessionId), videos: lines(row.sessionId) }))
      }
      return html(reply, 200, renderPartageLogin({ title: titleOfPage(row.sessionId), erreur: null }))
    })

    app.post('/partage/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const row = services.partages.get(request.params.id)
      if (row == null) return reply.status(404).send()
      return attempt(request, reply, row, (request.body as URLSearchParams | undefined)?.get?.('motDePasse') ?? '')
    })

    app.get('/partage/:id/regarder/:jobId', async (request: FastifyRequest<{ Params: { id: string; jobId: string } }>, reply) => {
      const row = services.partages.get(request.params.id)
      if (row == null) return reply.status(404).send()
      if (!services.partages.checkPass(row, request.headers.cookie)) return reply.redirect(`/partage/${row.id}`, 303)
      const video = lines(row.sessionId).find((line) => line.jobId === request.params.jobId)
      if (video == null) return reply.status(404).send()
      const origin = new URL(services.montage.downloadUrl(video.jobId, true)).origin
      return html(reply, 200, renderPartageLecteur({ id: row.id, video }), origin)
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
