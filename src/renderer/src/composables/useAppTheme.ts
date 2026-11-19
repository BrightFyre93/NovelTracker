import type { AppSettings } from '../../../shared/contracts'

type ThemeSetting = AppSettings['appTheme']

const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)')
let currentSetting: ThemeSetting = 'light'

function resolveTheme(setting: ThemeSetting): 'light' | 'dark' {
  if (setting === 'system') return systemDarkQuery.matches ? 'dark' : 'light'
  return setting
}

/**
 * Applies the saved theme. "system" follows the operating system and keeps
 * following it while the app is open.
 */
export function applyAppTheme(setting: ThemeSetting): void {
  currentSetting = setting
  document.documentElement.dataset.theme = resolveTheme(setting)
}

systemDarkQuery.addEventListener('change', () => {
  if (currentSetting === 'system') applyAppTheme('system')
})
