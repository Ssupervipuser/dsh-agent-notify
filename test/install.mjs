// Install/update dsh-agent-notify into the desktop profile.
//
// The running DSH host caches ESM modules by resolved URL, so overwriting the
// plugin entry does not hot-update live code. The installed copy therefore uses
// a stable shim entry (lib/index.js) that dynamic-imports the current build from
// lib/releases/impl-<build>.js, selected by lib/current-build.txt. Re-running
// this installer publishes a new impl file, and a config reload (or row toggle)
// picks it up without restarting the app.
//
// The workspace copy stays canonical: lib/index.js is the real implementation.
// Safe to re-run.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// This script lives in <plugin>/test/, so the plugin root is one level up. Deriving
// it from the script location keeps the installer portable across clones.
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-agent-notify'
const profileDir = path.join(homedir(), '.dsh', 'profiles', 'desktop')
const manifestPath = path.join(profileDir, 'package.json')
const targetDir = path.join(profileDir, 'node_modules', packageName)
const legacyDirs = ['dsh-task-notify'].map((name) => path.join(profileDir, 'node_modules', name))

if (!existsSync(path.join(pluginDir, 'lib', 'index.js'))) throw new Error(`plugin not found at ${pluginDir}`)

// Stable shim: the only module URL the host caches. It reads the current build
// name from disk on every activation, so new impl builds load on reload.
const SHIM = `/**
 * dsh-agent-notify — stable installed entry.
 *
 * The host caches imported modules by URL, so this file must never change. It
 * resolves the current implementation build from ./current-build.txt and imports
 * that (new) URL, which is what makes plugin updates apply on config reload
 * without restarting DeepSeek Harness.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'agent-notify'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export async function apply(ctx, config) {
  const build = readFileSync(path.join(HERE, 'current-build.txt'), 'utf8').trim()
  const impl = await import('./releases/' + build)
  return impl.apply(ctx, config)
}
`

// 1. Back up the profile manifest layer. The backup goes to the OS temp dir so a
// clone's plugin directory never accumulates install-time state.
const backupDir = path.join(tmpdir(), `dsh-agent-notify-profile-backup-${Date.now()}`)
mkdirSync(backupDir, { recursive: true })
for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  const source = path.join(profileDir, file)
  if (existsSync(source)) cpSync(source, path.join(backupDir, file))
}
console.log(`backup -> ${backupDir}`)

// 2. Publish the implementation as a freshly named build.
const buildId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const buildFile = `impl-${buildId}.js`
const releasesDir = path.join(targetDir, 'lib', 'releases')
mkdirSync(releasesDir, { recursive: true })
writeFileSync(path.join(releasesDir, buildFile), readFileSync(path.join(pluginDir, 'lib', 'index.js'), 'utf8'), 'utf8')
for (const file of readdirSync(releasesDir)) {
  if (file !== buildFile) rmSync(path.join(releasesDir, file), { force: true })
}
writeFileSync(path.join(targetDir, 'lib', 'current-build.txt'), `${buildFile}\n`, 'utf8')
writeFileSync(path.join(targetDir, 'lib', 'index.js'), SHIM, 'utf8')

// 3. Refresh scripts, patch layer and docs.
for (const file of ['notify.ps1', 'card.ps1']) {
  cpSync(path.join(pluginDir, 'lib', file), path.join(targetDir, 'lib', file))
}
cpSync(path.join(pluginDir, 'cordis.patch.yml'), path.join(targetDir, 'cordis.patch.yml'))
cpSync(path.join(pluginDir, 'README.md'), path.join(targetDir, 'README.md'))
writeFileSync(
  path.join(targetDir, 'package.json'),
  `${JSON.stringify(JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8')), null, 2)}\n`,
  'utf8',
)
console.log(`build -> lib/releases/${buildFile}`)

// 4. Drop the previous package identity (its cached module can never be updated).
for (const legacy of legacyDirs) {
  if (existsSync(legacy)) {
    rmSync(legacy, { recursive: true, force: true })
    console.log(`removed legacy ${path.basename(legacy)}`)
  }
}

// 5. Profile manifest: dependency + bundle selection.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
delete manifest.dependencies['dsh-task-notify']
manifest.dependencies[packageName] = `file:${pluginDir.replace(/\\/g, '/')}`
const bundles = manifest.dsh?.profile?.bundles
if (!Array.isArray(bundles)) throw new Error('unexpected profile manifest: dsh.profile.bundles missing')
const filtered = bundles.filter((name) => name !== 'dsh-task-notify' && name !== packageName)
filtered.push(packageName)
manifest.dsh.profile.bundles = filtered
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`profile bundles -> ${filtered.join(', ')}`)
