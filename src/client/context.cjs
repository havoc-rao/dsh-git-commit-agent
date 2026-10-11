/** Optional public host service lookup shared by client features. */

/** Resolve a host service, tolerating an absent one. */
function service(ctx, name) {
  if (ctx.get !== undefined) {
    const found = ctx.get(name)
    if (found !== undefined && found !== null) return found
  }
  return ctx[name]
}

module.exports = { service }
