/**
 * Which hops of a request's path Fastify believes about the visitor's address.
 *
 * In production exactly one proxy is in front of the API: the stack's edge container
 * (deploy/edge/Caddyfile), which gets the request from the server's front proxy
 * (vps-edge), which got it from the visitor. Each of them replaces `X-Forwarded-For` with
 * the one real address, so what reaches the API is a single value set by the edge.
 *
 * Fastify's `trustProxy: true` would believe every hop and take the LEFTMOST value, which is
 * the one a visitor can write. Trusting only the connection itself (hop 0, the edge) makes
 * Fastify walk from the right: the edge's own value is the address, and anything a visitor
 * put to its left is ignored. With no proxy in front (development, tests) there is no header
 * and the address is the connection's.
 */
export function trustEdgeOnly(_address: string, hop: number): boolean {
  return hop === 0;
}
