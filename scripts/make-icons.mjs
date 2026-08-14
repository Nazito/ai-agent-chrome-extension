import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'src/icons')
mkdirSync(outDir, { recursive: true })

const mark = readFileSync(join(root, 'src/sidepanel/mark.svg'), 'utf8')
  .replace(/<!DOCTYPE[\s\S]*?>/, '')
  .replace(/<svg([^>]*)viewBox="0 0 64\.003 64\.003"/, '<svg$1viewBox="-5 -5 74.003 74.003"')
  .replace(
    /<svg([^>]*)>/,
    `<svg$1>
  <rect x="-5" y="-5" width="74.003" height="74.003" fill="#05070c"/>`,
  )

for (const size of [16, 48, 128]) {
  const png = new Resvg(mark, {
    fitTo: { mode: 'width', value: size },
    background: '#05070c',
  })
    .render()
    .asPng()
  writeFileSync(join(outDir, `icon${size}.png`), png)
}

console.log('Wrote src/icons from mark.svg')
