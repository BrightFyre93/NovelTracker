import { mkdir, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import type { BrowserSessionInfo } from '../../shared/contracts'
import {
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_PROFILE_DIRECTORY_NAME,
  MAX_BROWSER_TABS
} from '../../shared/constants'
import {
  OperationCancelledError,
  TransientNetworkError,
  VerificationRequiredError
} from '../../shared/errors'
import { validateHttpUrl, withDomainRequestSlot } from './scraper'

let browserContext: BrowserContext | null = null
let browserContextPromise: Promise<BrowserContext> | null = null
let verificationPage: Page | null = null
let currentProfileDirectory = ''
let browserOperationActive = false
const browserOperationWaiters = new Set<() => void>()

function createBrowserOperationRelease(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const nextWaiter = browserOperationWaiters.values().next().value
    if (nextWaiter) nextWaiter()
    else browserOperationActive = false
  }
}

async function acquireBrowserOperationSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new OperationCancelledError('Browser-assisted page retrieval was cancelled.')
  if (!browserOperationActive) {
    browserOperationActive = true
    return createBrowserOperationRelease()
  }

  await new Promise<void>((resolveWait, rejectWait) => {
    const cleanup = (): void => {
      browserOperationWaiters.delete(onAvailable)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAvailable = (): void => {
      cleanup()
      resolveWait()
    }
    const onAbort = (): void => {
      cleanup()
      rejectWait(new OperationCancelledError('Browser-assisted page retrieval was cancelled.'))
    }
    browserOperationWaiters.add(onAvailable)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })

  return createBrowserOperationRelease()
}

async function withBrowserOperation<T>(
  url: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const releaseBrowser = await acquireBrowserOperationSlot(signal)
  try {
    return await withDomainRequestSlot(url, signal, operation)
  } finally {
    releaseBrowser()
  }
}

function ensureBrowserTabAvailable(context: BrowserContext): void {
  if (context.pages().length >= MAX_BROWSER_TABS) {
    throw new Error(
      `The browser tab limit of ${MAX_BROWSER_TABS} is reached. Close another tab and retry.`
    )
  }
}

function profileDirectory(dataDirectory: string): string {
  const root = resolve(dataDirectory)
  const profile = resolve(root, BROWSER_PROFILE_DIRECTORY_NAME)
  if (!profile.startsWith(`${root}${sep}`)) {
    throw new Error('The local browser profile path is invalid.')
  }
  return profile
}

async function getBrowserContext(dataDirectory: string): Promise<BrowserContext> {
  if (browserContext && currentProfileDirectory === profileDirectory(dataDirectory)) {
    return browserContext
  }
  if (browserContextPromise) return browserContextPromise

  const profile = profileDirectory(dataDirectory)
  const launch = async (): Promise<BrowserContext> => {
    const { chromium } = await import('playwright')
    await mkdir(profile, { recursive: true })
    const context = await chromium.launchPersistentContext(profile, {
      acceptDownloads: false,
      headless: false
    })
    browserContext = context
    currentProfileDirectory = profile
    verificationPage = context.pages()[0] ?? await context.newPage()
    context.on('close', () => {
      if (browserContext === context) {
        browserContext = null
        verificationPage = null
        currentProfileDirectory = ''
      }
    })
    return context
  }
  browserContextPromise = launch().finally(() => {
    browserContextPromise = null
  })
  return browserContextPromise
}

async function navigate(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, {
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
      waitUntil: 'domcontentloaded'
    })
    await page.locator('body').waitFor({ state: 'attached', timeout: BROWSER_NAVIGATION_TIMEOUT_MS })
    await page.waitForTimeout(750)
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new TransientNetworkError('The browser timed out while loading the page.')
    }
    throw new TransientNetworkError(
      'The browser could not load the requested page. Check the URL and connection.'
    )
  }
}

export async function openVerificationBrowser(
  value: unknown,
  dataDirectory: string
): Promise<BrowserSessionInfo> {
  const url = validateHttpUrl(value)
  const context = await getBrowserContext(dataDirectory)
  return withBrowserOperation(url, undefined, async () => {
    if (!verificationPage || verificationPage.isClosed()) {
      ensureBrowserTabAvailable(context)
      verificationPage = await context.newPage()
    }
    await navigate(verificationPage, url)
    return { title: await verificationPage.title() }
  })
}

export async function readBrowserPage(
  value: unknown,
  signal?: AbortSignal
): Promise<{ html: string; finalUrl: string }> {
  const url = validateHttpUrl(value)
  const context = browserContext ?? (browserContextPromise ? await browserContextPromise : null)
  if (!context) {
    throw new VerificationRequiredError(
      'Open the visible browser and complete any required manual verification first.'
    )
  }
  if (signal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')

  return withBrowserOperation(url, signal, async () => {
    if (signal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
    const visibleVerificationPage =
      verificationPage && !verificationPage.isClosed() ? verificationPage : null
    const visiblePageUrl = visibleVerificationPage?.url() ?? ''
    if (
      visibleVerificationPage &&
      visiblePageUrl.startsWith('http') &&
      validateHttpUrl(visiblePageUrl) === url
    ) {
      await visibleVerificationPage.locator('body').waitFor({ state: 'attached', timeout: BROWSER_NAVIGATION_TIMEOUT_MS })
      await visibleVerificationPage.waitForTimeout(750)
      if (signal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
      return {
        html: await visibleVerificationPage.content(),
        finalUrl: validateHttpUrl(visibleVerificationPage.url())
      }
    }

    ensureBrowserTabAvailable(context)
    const page = await context.newPage()
    const abort = (): void => {
      void page.close()
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await navigate(page, url)
      if (signal?.aborted) throw new OperationCancelledError('Browser-assisted page retrieval was cancelled.')
      return { html: await page.content(), finalUrl: validateHttpUrl(page.url()) }
    } catch (error) {
      if (signal?.aborted) {
        throw new OperationCancelledError('Browser-assisted page retrieval was cancelled.')
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      if (!page.isClosed()) await page.close()
    }
  })
}

export async function clearBrowserSession(dataDirectory: string): Promise<void> {
  const profile = profileDirectory(dataDirectory)
  if (currentProfileDirectory && currentProfileDirectory !== profile) {
    throw new Error('The active browser profile does not match the app data directory.')
  }
  if (browserContextPromise) await browserContextPromise
  if (browserContext) {
    const context = browserContext
    browserContext = null
    verificationPage = null
    currentProfileDirectory = ''
    await context.close()
  }
  await rm(profile, { recursive: true, force: true })
}

export async function closeBrowserSession(): Promise<void> {
  if (browserContextPromise) await browserContextPromise
  const context = browserContext
  browserContext = null
  verificationPage = null
  currentProfileDirectory = ''
  if (context) await context.close()
}
