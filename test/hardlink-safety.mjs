// Regression test: install.mjs must never write through a hardlink into the
// canonical plugin.
//
// pnpm installs a `file:` dependency by hardlinking it into node_modules, so an
// installed file is normally the SAME inode as its workspace source. Before the
// detach() fix, running the installer overwrote the canonical lib/index.js with
// the 21-line shim (writeFileSync through the link) and then aborted on
// cpSync with ERR_FS_CP_EINVAL ("src and dest cannot be the same"), leaving the
// source corrupted and the install half-done.
//
// This test reproduces that exact layout in a throwaway sandbox and asserts the
// canonical plugin is byte-identical afterwards.
//
// Run: node test/hardlink-safety.mjs
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installer = path.join(pluginDir, 'test', 'install.mjs')
const sandbox = path.join(tmpdir(), `dsh-agent-notify-hardlink-test-${Date.now()}`)
const sandboxProfile = path.join(sandbox, 'profile')
const sandboxTarget = path.join(sandboxProfile, 'node_modules', 'dsh-agent-notify')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Every file install.mjs writes into the installed tree.
const INSTALLED = [
  ['lib/index.js', 'lib/index.js'],
  ['lib/notify.ps1', 'lib/notify.ps1'],
  ['lib/card.ps1', 'lib/card.ps1'],
  ['cordis.patch.yml', 'cordis.patch.yml'],
  ['README.md', 'README.md'],
  ['package.json', 'package.json'],
]

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

try {
  // --- canonical source baseline ---
  const before = {}
  for (const [source] of INSTALLED) {
    const p = path.join(pluginDir, source)
    if (!existsSync(p)) throw new Error(`missing canonical file: ${source}`)
    before[source] = sha(p)
  }
  const shimCandidate = path.join(pluginDir, 'lib', 'index.js')
  const implSize = statSync(shimCandidate).size

  // --- build a sandbox profile that mimics a pnpm file: install ---
  mkdirSync(sandboxTarget, { recursive: true })
  writeFileSync(
    path.join(sandboxProfile, 'package.json'),
    `${JSON.stringify({ name: 'sandbox-profile', dsh: { profile: { bundles: ['dsh-agent-notify'] } } }, null, 2)}\n`,
    'utf8',
  )

  let linked = 0
  for (const [source, dest] of INSTALLED) {
    const from = path.join(pluginDir, source)
    const to = path.join(sandboxTarget, dest)
    mkdirSync(path.dirname(to), { recursive: true })
    linkSync(from, to)
    linked += 1
  }
  check('sandbox reproduces the pnpm hardlink layout', linked === INSTALLED.length, `${linked} files hardlinked`)
  check(
    'installed lib/index.js shares an inode with the canonical source',
    statSync(path.join(sandboxTarget, 'lib', 'index.js')).ino === statSync(shimCandidate).ino,
    'precondition for the bug below',
  )

  // --- run the installer against the sandbox ---
  const run = spawnSync(process.execPath, [installer], {
    env: { ...process.env, DSH_PROFILE_DIR: sandboxProfile },
    stdio: 'inherit',
  })
  check('installer exits cleanly', run.status === 0, `exit ${run.status}`)

  // --- the canonical plugin must be untouched ---
  for (const [source] of INSTALLED) {
    const p = path.join(pluginDir, source)
    check(
      `canonical ${source} unchanged`,
      sha(p) === before[source],
      sha(p) === before[source] ? '' : 'SOURCE WAS MODIFIED',
    )
  }

  // The specific corruption the bug produced: the implementation replaced by
  // the much smaller shim.
  check(
    'canonical lib/index.js still holds the implementation, not the shim',
    statSync(shimCandidate).size === implSize,
    `${statSync(shimCandidate).size} bytes (was ${implSize})`,
  )

  // --- the install itself must have worked ---
  const installedIndex = path.join(sandboxTarget, 'lib', 'index.js')
  const buildName = readFileSync(path.join(sandboxTarget, 'lib', 'current-build.txt'), 'utf8').trim()
  const installedImpl = path.join(sandboxTarget, 'lib', 'releases', buildName)
  check('shim written to the installed entry', existsSync(installedIndex))
  check('shim is a separate file, not linked to the source', statSync(installedIndex).ino !== statSync(shimCandidate).ino)
  check('build published to lib/releases/', existsSync(installedImpl), buildName)
  check('published build matches the canonical implementation', existsSync(installedImpl) && sha(installedImpl) === before['lib/index.js'])

  // --- and the shim must actually load and delegate ---
  const mod = await import(pathToFileURL(installedIndex).href)
  check('installed shim exposes apply()', typeof mod.apply === 'function')
  check('installed shim keeps the plugin name', mod.name === 'agent-notify', String(mod.name))
} catch (error) {
  check('test ran without throwing', false, error.message)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
