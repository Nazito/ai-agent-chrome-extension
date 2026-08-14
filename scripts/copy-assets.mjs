import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const buildFile = join(root, '.build-number')

let build = 0
try {
  build = Number.parseInt(readFileSync(buildFile, 'utf8').trim(), 10) || 0
} catch {
  build = 0
}
build += 1
writeFileSync(buildFile, `${build}\n`)

mkdirSync(join(dist, 'sidepanel'), { recursive: true })
mkdirSync(join(dist, 'icons'), { recursive: true })

const html = readFileSync(join(root, 'src/sidepanel/index.html'), 'utf8').replaceAll(
  '__BUILD__',
  String(build),
)

copyFileSync(join(root, 'src/manifest.json'), join(dist, 'manifest.json'))
writeFileSync(join(dist, 'sidepanel/index.html'), html)
copyFileSync(join(root, 'src/sidepanel/styles.css'), join(dist, 'sidepanel/styles.css'))
copyFileSync(join(root, 'src/sidepanel/mark.svg'), join(dist, 'sidepanel/mark.svg'))
cpSync(join(root, 'src/_locales'), join(dist, '_locales'), { recursive: true })

for (const name of ['icon16.png', 'icon48.png', 'icon128.png']) {
  copyFileSync(join(root, 'src/icons', name), join(dist, 'icons', name))
}

console.log(`build ${build}`)
