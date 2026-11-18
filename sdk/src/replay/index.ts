import type { Client } from '../client'
import type { ReplayHost } from '../types'
import { start } from './recorder'

/**
 * Entry of wgo-replay.js. The main SDK (same version, same directory) loads it only when the project records
 * sessions and this one may be recorded, after setting `client.rc` (see Client.replay in ../client.ts).
 */
const g = (globalThis as { __wgo?: { client: Client | null; rs?: () => void } }).__wgo
const cl = g?.client
if (g && cl?.rc && !g.rs) {
  const host: ReplayHost = {
    c: cl.rc, k: cl.cfg.writeKey, ep: cl.cfg.endpoint, debug: cl.cfg.debug, mem: cl.cfg.cookieless, ctx: cl.ctx,
    sid: () => cl.session.peek(),
    aid: () => cl.session.aid,
    clean: (u) => cl.clean(u),
    on: (f) => { cl.subs.push(f); return () => { cl.subs = cl.subs.filter((x) => x !== f) } },
  }
  try {
    const stop = start(host)
    g.rs = () => { g.rs = undefined; stop() }
  } catch (e) {
    if (host.debug) console.debug('[wgo replay] failed to start', e)
  }
}
