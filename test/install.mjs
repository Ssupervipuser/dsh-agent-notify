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
//
// HARDLINKS: pnpm installs a `file:` dependency by hardlinking the plugin into
// node_modules, so an installed file is usually the SAME inode as its workspace
// source (`fsutil hardlink list <installed file>` shows both paths). Writing
// through that link is not a copy operation — it mutates the canonical file:
//   - writeFileSync truncates the shared inode, destroying the implementation
//     this script just read the build from;
//   - cpSync refuses outright with ERR_FS_CP_EINVAL ("src and dest cannot be
//     the same"), aborting the install halfway.
// Every write into the installed tree therefore goes through `detach()` below,
// which drops the directory entry first so the write lands on a fresh inode.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// This script lives in <plugin>/test/, so the plugin root is one level up. Deriving
// it from the script location keeps the installer portable across clones.
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-agent-notify'
// DSH_PROFILE_DIR lets the test suite install into a sandbox instead of the
// live profile.
const profileDir = process.env.DSH_PROFILE_DIR
  ? path.resolve(process.env.DSH_PROFILE_DIR)
  : path.join(homedir(), '.dsh', 'profiles', 'desktop')
const manifestPath = path.join(profileDir, 'package.json')
const targetDir = path.join(profileDir, 'node_modules', packageName)
const legacyDirs = ['dsh-task-notify'].map((name) => path.join(profileDir, 'node_modules', name))

if (!existsSync(path.join(pluginDir, 'lib', 'index.js'))) throw new Error(`plugin not found at ${pluginDir}`)

const detached = []

// True when two paths are two names for one file (hardlink siblings).
function sameFile(a, b) {
  try {
    const [sa, sb] = [statSync(a), statSync(b)]
    return sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}

// Remove `dest`'s directory entry so the write that follows cannot reach the
// canonical file through a hardlink. `source` is only used to report the link
// we are about to break, so a destructive outcome is never silent.
function detach(dest, source) {
  if (!existsSync(dest)) return
  if (source && sameFile(source, dest)) detached.push(path.relative(profileDir, dest))
  rmSync(dest, { force: true })
}

// Resolve `p` even when its tail does not exist yet: realpath the longest
// existing prefix (following junctions/symlinks) and re-append the rest.
function resolveReal(p) {
  let prefix = p
  const tail = []
  while (!existsSync(prefix)) {
    tail.unshift(path.basename(prefix))
    const parent = path.dirname(prefix)
    if (parent === prefix) break
    prefix = parent
  }
  return path.join(realpathSync(prefix), ...tail)
}

// A DIRECTORY reparse point (junction / symlink) is a different threat from a
// hardlink, and detach() cannot defend against it: if the installed directory
// resolves back into the canonical plugin (pnpm `link:`, link-workspace-packages,
// npm link, or a manually junctioned node_modules), then dest and source are the
// same file, so detach()'s rmSync DELETES the canonical file and the next cpSync
// aborts with ENOENT — leaving the source tree emptied. Hardlinks are invisible
// to realpathSync, so this check only rejects directory reparse points and the
// hardlink handling above still does the real work.
function assertOutsideCanonical(p, label) {
  const real = resolveReal(p)
  const root = realpathSync(pluginDir)
  const [a, b] = process.platform === 'win32' ? [real.toLowerCase(), root.toLowerCase()] : [real, root]
  if (a === b || a.startsWith(b + path.sep)) {
    throw new Error(
      `${label} resolves into the canonical plugin:\n  ${p}\n  -> ${real}\n` +
        'Refusing to install: writing there would overwrite or delete the plugin source.',
    )
  }
}

// Refuse to touch anything before the first write if the destination is redirected
// into the canonical source tree.
for (const [p, label] of [
  [profileDir, 'profile dir'],
  [targetDir, 'installed plugin dir'],
  [path.join(targetDir, 'lib'), 'installed lib dir'],
  [path.join(targetDir, 'lib', 'releases'), 'installed releases dir'],
  [manifestPath, 'profile manifest'],
]) {
  assertOutsideCanonical(p, label)
}

// Validate the target BEFORE writing anything. Without this the backup and the
// published build would already exist for a profile we then reject, which looks
// like a half-finished install rather than a clean refusal.
if (!existsSync(manifestPath)) {
  throw new Error(
    `not a dsh profile (no package.json):\n  ${profileDir}\n` +
      'Point DSH_PROFILE_DIR at an existing profile directory.',
  )
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!Array.isArray(manifest.dsh?.profile?.bundles)) {
  throw new Error(
    `unexpected profile manifest: dsh.profile.bundles missing\n  ${manifestPath}`,
  )
}

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
// Read the canonical implementation BEFORE touching the installed tree: if a
// previous install hardlinked it, breaking that link must not race this read.
const implementation = readFileSync(path.join(pluginDir, 'lib', 'index.js'), 'utf8')
const buildId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const buildFile = `impl-${buildId}.js`
const releasesDir = path.join(targetDir, 'lib', 'releases')
mkdirSync(releasesDir, { recursive: true })
detach(path.join(releasesDir, buildFile))
writeFileSync(path.join(releasesDir, buildFile), implementation, 'utf8')
for (const file of readdirSync(releasesDir)) {
  if (file !== buildFile) rmSync(path.join(releasesDir, file), { force: true })
}
detach(path.join(targetDir, 'lib', 'current-build.txt'))
writeFileSync(path.join(targetDir, 'lib', 'current-build.txt'), `${buildFile}\n`, 'utf8')
// The entry that the host caches. detach() is mandatory here: without it this
// write is redirected into the canonical lib/index.js.
detach(path.join(targetDir, 'lib', 'index.js'), path.join(pluginDir, 'lib', 'index.js'))
writeFileSync(path.join(targetDir, 'lib', 'index.js'), SHIM, 'utf8')

// 3. Refresh scripts, patch layer and docs. cpSync throws ERR_FS_CP_EINVAL when
// source and destination are the same inode, so each destination is detached.
for (const file of ['notify.ps1', 'card.ps1']) {
  detach(path.join(targetDir, 'lib', file), path.join(pluginDir, 'lib', file))
  cpSync(path.join(pluginDir, 'lib', file), path.join(targetDir, 'lib', file))
}
detach(path.join(targetDir, 'cordis.patch.yml'), path.join(pluginDir, 'cordis.patch.yml'))
cpSync(path.join(pluginDir, 'cordis.patch.yml'), path.join(targetDir, 'cordis.patch.yml'))
detach(path.join(targetDir, 'README.md'), path.join(pluginDir, 'README.md'))
cpSync(path.join(pluginDir, 'README.md'), path.join(targetDir, 'README.md'))
detach(path.join(targetDir, 'package.json'), path.join(pluginDir, 'package.json'))
writeFileSync(
  path.join(targetDir, 'package.json'),
  `${JSON.stringify(JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8')), null, 2)}\n`,
  'utf8',
)
console.log(`build -> lib/releases/${buildFile}`)
if (detached.length > 0) {
  console.log(`broke ${detached.length} hardlink(s) into the canonical plugin:`)
  for (const file of detached) console.log(`  ${file}`)
}

// 4. Drop the previous package identity (its cached module can never be updated).
for (const legacy of legacyDirs) {
  if (existsSync(legacy)) {
    rmSync(legacy, { recursive: true, force: true })
    console.log(`removed legacy ${path.basename(legacy)}`)
  }
}

// 5. Profile manifest: dependency + bundle selection.
manifest.dependencies = manifest.dependencies ?? {}
delete manifest.dependencies['dsh-task-notify']
manifest.dependencies[packageName] = `file:${pluginDir.replace(/\\/g, '/')}`
const bundles = manifest.dsh.profile.bundles
const filtered = bundles.filter((name) => name !== 'dsh-task-notify' && name !== packageName)
filtered.push(packageName)
manifest.dsh.profile.bundles = filtered
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`profile bundles -> ${filtered.join(', ')}`)
