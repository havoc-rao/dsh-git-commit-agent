import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exactPlanPresentation, recentPlanIndex, sessionPlanPresentations } from '../src/host/plan-http.js'

test('GET reader never creates missing stores or repairs corrupt documents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plan-ro-'))
  try {
    assert.deepEqual(await sessionPlanPresentations({ directory: join(root, 'absent') }, 'session'), [])
    assert.deepEqual(await recentPlanIndex({ directory: join(root, 'absent') }), { schemaVersion: 1, plans: [], hasMore: false })
    assert.equal(await exactPlanPresentation({ directory: join(root, 'absent') }, 'session', { taskId: 'task', planId: 'plan', revision: 1, digest: 'digest' }), null)
    assert.deepEqual(await readdir(root), [])
    const file = join(root, 'store.json')
    await writeFile(file, '{broken', 'utf8')
    await assert.rejects(sessionPlanPresentations({ directory: root }, 'session'))
    await assert.rejects(recentPlanIndex({ directory: root }))
    await assert.rejects(exactPlanPresentation({ directory: root }, 'session', { taskId: 'task', planId: 'plan', revision: 1, digest: 'digest' }))
    assert.equal(await readFile(file, 'utf8'), '{broken')
    assert.deepEqual(await readdir(root), ['store.json'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
