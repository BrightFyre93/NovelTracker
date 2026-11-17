import type { AppSettings } from '../../shared/contracts'
import { normalizeDomainRequestDelays } from '../../shared/domainRequestPreferences'
import { normalizeSiteExtractionPreferences } from '../../shared/siteExtractionPreferences'
import { SerialQueue } from './serialQueue'
import { readSettings, writeSettings } from './localStore'

export class SettingsService {
  private readonly writes = new SerialQueue()
  private readonly listeners = new Set<
    (settings: AppSettings, patch: Partial<AppSettings>) => void
  >()
  private settings: AppSettings | null = null

  constructor(private readonly dataDirectory: () => string) {}

  async initialize(): Promise<AppSettings> {
    this.settings = await readSettings(this.dataDirectory())
    return this.copySettings(this.settings)
  }

  async get(): Promise<AppSettings> {
    if (!this.settings) return this.initialize()
    return this.copySettings(this.settings)
  }

  get current(): AppSettings {
    if (!this.settings) {
      throw new Error('Settings have not been initialized.')
    }
    return this.copySettings(this.settings)
  }

  update(
    patch: Partial<AppSettings>
  ): Promise<AppSettings> {
    return this.updateWith(() => patch)
  }

  updateWith(
    createPatch: (
      current: AppSettings
    ) => Partial<AppSettings> | Promise<Partial<AppSettings>>
  ): Promise<AppSettings> {
    return this.writes.enqueue(async () => {
      const current = this.settings ?? (await readSettings(this.dataDirectory()))
      const patch = await createPatch(this.copySettings(current))
      const next = {
        ...current,
        ...patch,
        domainRequestDelays:
          patch.domainRequestDelays === undefined
            ? current.domainRequestDelays
            : normalizeDomainRequestDelays(patch.domainRequestDelays),
        siteExtractionPreferences:
          patch.siteExtractionPreferences === undefined
            ? current.siteExtractionPreferences
            : normalizeSiteExtractionPreferences(
                patch.siteExtractionPreferences
              )
      }
      await writeSettings(this.dataDirectory(), next)
      this.settings = next
      this.emitChange(patch)
      return this.copySettings(next)
    })
  }

  onDidChange(
    listener: (settings: AppSettings, patch: Partial<AppSettings>) => void
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  drain(): Promise<void> {
    return this.writes.drain()
  }

  private emitChange(patch: Partial<AppSettings>): void {
    const snapshot = this.copySettings(this.settings!)
    for (const listener of this.listeners) {
      try {
        listener(this.copySettings(snapshot), { ...patch })
      } catch (error) {
        console.error('Settings change listener failed:', error)
      }
    }
  }

  private copySettings(settings: AppSettings): AppSettings {
    return {
      ...settings,
      domainRequestDelays: settings.domainRequestDelays.map((preference) => ({
        ...preference
      })),
      siteExtractionPreferences: settings.siteExtractionPreferences.map(
        (preference) => ({ ...preference })
      ),
      epubOutputPreferences: { ...settings.epubOutputPreferences }
    }
  }
}
