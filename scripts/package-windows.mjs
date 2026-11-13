import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'electron-builder'

if (process.platform !== 'win32') {
  throw new Error('The Windows installer must be packaged on Windows.')
}

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const browserPath = resolve(projectRoot, '.playwright-browsers')
const environment = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browserPath
}

execFileSync(
  process.execPath,
  [resolve(projectRoot, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
  { cwd: projectRoot, env: environment, stdio: 'inherit' }
)

process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath
await build({ win: ['nsis'] })
