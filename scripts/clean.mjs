import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Fixed project-local generated directories only; never remove source or fixtures.
const root = new URL('../', import.meta.url)
for (const name of ['dist', '.build', 'lib']) {
  const target = new URL(`${name}/`, root)
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)) {
    throw new Error(`Refusing to clean outside the project: ${target.href}`)
  }
  await rm(fileURLToPath(target), { recursive: true, force: true })
}
