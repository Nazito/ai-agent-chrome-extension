import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

mkdirSync(join(dist, 'sidepanel'), { recursive: true })
mkdirSync(join(dist, 'icons'), { recursive: true })

copyFileSync(join(root, 'src/manifest.json'), join(dist, 'manifest.json'))
copyFileSync(join(root, 'src/sidepanel/index.html'), join(dist, 'sidepanel/index.html'))
copyFileSync(join(root, 'src/sidepanel/styles.css'), join(dist, 'sidepanel/styles.css'))

for (const name of ['icon16.png', 'icon48.png', 'icon128.png']) {
  copyFileSync(join(root, 'src/icons', name), join(dist, 'icons', name))
}
