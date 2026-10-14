/** Optional command-palette integration and Cordis-owned lifecycle. */
const { service } = require('../context.cjs')
const { registerCommitPalette } = require('./commands.cjs')

function applyCommandPalette(ctx) {
  // Absence/late arrival of palette never blocks the other client contributions.
  if (typeof ctx.inject !== 'function') return
  return ctx.inject(['commandPalette'], function (paletteCtx) {
    paletteCtx.effect(function () {
      return registerCommitPalette(paletteCtx, service(paletteCtx, 'commandPalette'))
    })
  })
}

module.exports = { applyCommandPalette }
