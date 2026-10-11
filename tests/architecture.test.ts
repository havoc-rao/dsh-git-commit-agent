import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

test('package exports resolve to production output, never test output', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.main, './dist/index.js')
  assert.equal(pkg.types, './dist/index.d.ts')
  for (const specifier of ['.', './core', './client']) {
    const entry = pkg.exports[specifier]
    assert.ok(entry.default.startsWith('./dist/'))
    await readFile(new URL(entry.default, root))
    if (entry.types) await readFile(new URL(entry.types, root))
  }
  assert.ok(!pkg.files.some((path: string) => /tests|\.build|^src|^client|^lib/.test(path)))
  const packageName: string = pkg.name
  const publicApi = await import(packageName)
  const core = await import(`${packageName}/core`)
  assert.equal(typeof publicApi.apply, 'function')
  assert.equal(typeof core.CommitAgentService, 'function')
})

test('domain and shared source do not depend on runtime adapters', async () => {
  async function check(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
      if (entry.isDirectory()) await check(url)
      else if (entry.name.endsWith('.ts')) {
        const source = await readFile(url, 'utf8')
        const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)]
        for (const match of imports) {
          assert.ok(!/(?:^|\/)(?:host|client)(?:\/|$)|^@deepseek-ai\/dsh-/.test(match[1]!),
            `${url.pathname} imports runtime adapter ${match[1]}`)
        }
      }
    }
  }
  await check(new URL('src/core/', root))
  await check(new URL('src/shared/', root))
})
