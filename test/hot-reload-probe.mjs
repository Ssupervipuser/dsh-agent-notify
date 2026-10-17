// Toggle the agent-notify row off/on through the profile patch layer, to see
// whether a module change hot-applies (the HMR watcher reloads configuration).
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const patchPath = path.join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const base = readFileSync(patchPath, 'utf8')
const marker = '\n# transient hot-reload probe (removed by the installer)\n'
const entries = (disabled) => `${marker}- id: agent-notify\n  disabled: ${disabled}\n`

function write(disabled) {
  const withoutProbe = base.split(marker)[0].replace(/\n$/, '')
  writeFileSync(patchPath, `${withoutProbe}\n${entries(disabled)}`, 'utf8')
}

write(true)
console.log('probe: disabled=true written')
setTimeout(() => {
  write(false)
  console.log('probe: disabled=false written')
}, 2500)
setTimeout(() => {
  writeFileSync(patchPath, `${base.trimEnd()}\n`, 'utf8')
  console.log('probe: patch restored')
}, 6000)
