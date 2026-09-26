import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { contract } from '@conference-operator/contract'

export type Hub = ContractRouterClient<typeof contract>

/** The hub, typed, over HTTP, as a worker: its `wt_…` token on every call. */
export function connectHub(hubUrl: string, token: string): Hub {
  const base = new URL(hubUrl)
  // A hub served under a path (`https://x.fr/hub`) keeps it.
  const path = `${base.pathname.replace(/\/+$/, '')}/rpc` as `/${string}`
  return createORPCClient(
    new RPCLink({
      origin: base.origin,
      url: path,
      headers: () => ({ authorization: `Bearer ${token}` }),
    }),
  )
}
