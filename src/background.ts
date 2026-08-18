import { NamedError } from './shared/errors.js'
import { type CaptureSource, type CommandResponse, type ExtensionMessage, MessageType } from './shared/messages.js'
import { isTranslateDirection, type TranslateDirection } from './shared/storage.js'

let overlayTabIds = new Set<number>()
let overlayEnabled = false
let translateDirection: TranslateDirection = 'en-ru'
const overlayStatusByTab = new Map<number, { original: boolean; translation: boolean }>()

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !overlayEnabled || !tab.id || !isHttpTab(tab)) {
    return
  }
  if (overlayTabIds.has(tabId) || tab.audible || tab.active) {
    overlayTabIds.add(tabId)
    void injectOverlay(tabId)
      .then(() => chrome.tabs.sendMessage(tabId, enableOverlayMessage()).catch(() => undefined))
      .catch(() => undefined)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  overlayTabIds.delete(tabId)
  overlayStatusByTab.delete(tabId)
  void publishPlaqueCount()
})

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse: (response: CommandResponse) => void) => {
    if (message.type === MessageType.EnsureOffscreen) {
      ensureOffscreen()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }))
      return true
    }

    if (message.type === MessageType.StartTabCapture) {
      startTabCapture(message.streamId, message.source)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }))
      return true
    }

    if (message.type === MessageType.StopTabCapture) {
      stopTabCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }))
      return true
    }

    if (message.type === MessageType.EnableOverlay) {
      enableOverlay()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }))
      return true
    }

    if (message.type === MessageType.DisableOverlay) {
      disableOverlay()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }))
      return true
    }

    if (message.type === MessageType.ShowOverlayCaption) {
      void broadcastOverlay(message)
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.ClearOverlayCaption) {
      void broadcastOverlay(message)
      if (sender.tab) {
        void chrome.runtime.sendMessage(message).catch(() => undefined)
      }
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.OpenCaptionWindow) {
      if (isTranslateDirection(message.direction)) {
        translateDirection = message.direction
      }
      openCaptionWindow()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: errorMessage(error),
            code: error instanceof NamedError ? error.code : undefined,
          }),
        )
      return true
    }

    if (message.type === MessageType.SetTranslateDirection) {
      if (isTranslateDirection(message.direction)) {
        translateDirection = message.direction
        void broadcastOverlay({ type: MessageType.SetTranslateDirection, direction: translateDirection })
      }
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.CloseCaptionWindow) {
      disableOverlay()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }))
      return true
    }

    if (message.type === MessageType.OverlayStatus) {
      const tabId = sender.tab?.id
      if (tabId !== undefined) {
        overlayStatusByTab.set(tabId, {
          original: message.original,
          translation: message.translation,
        })
        void publishPlaqueCount()
      }
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.RequestPlaqueCount) {
      void publishPlaqueCount()
      sendResponse({ ok: true })
      return false
    }

    return false
  },
)

async function startTabCapture(streamId: string, source: CaptureSource): Promise<void> {
  await ensureOffscreen()
  const response = (await chrome.runtime.sendMessage({
    type: MessageType.OffscreenStartTab,
    streamId,
    source,
  } satisfies ExtensionMessage)) as CommandResponse | undefined
  if (response && response.ok === false) {
    throw new Error(response.error ?? 'offscreen capture failed')
  }
}

async function stopTabCapture(): Promise<void> {
  if (!(await hasOffscreenDocument())) {
    return
  }

  try {
    await chrome.runtime.sendMessage({
      type: MessageType.OffscreenStopTab,
    } satisfies ExtensionMessage)
  } catch {
    // Already closed.
  }

  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument()
  }
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/index.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Capture Meet/tab audio, play it back, and record chunks for translation.',
  })
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    return chrome.offscreen.hasDocument()
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  })
  return contexts.length > 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id !== undefined) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id })
    } catch {
      if (tab.windowId !== undefined) {
        await chrome.sidePanel.open({ windowId: tab.windowId })
      }
    }
    const url = tab.url ?? tab.pendingUrl ?? ''
    if (isHttpUrl(url)) {
      overlayEnabled = true
      overlayTabIds.add(tab.id)
      try {
        await injectOverlay(tab.id)
        await chrome.tabs.sendMessage(tab.id, enableOverlayMessage()).catch(() => undefined)
      } catch {
        // Site access may still block this tab.
      }
    }
  }
}

async function enableOverlay(): Promise<void> {
  overlayEnabled = true
  overlayTabIds = new Set(await overlayTargets())
  await Promise.all([...overlayTabIds].map((tabId) => injectOverlay(tabId).catch(() => undefined)))
  await broadcastOverlay(enableOverlayMessage())
}

async function disableOverlay(): Promise<void> {
  overlayEnabled = false
  await broadcastOverlay({ type: MessageType.DisableOverlay })
  overlayTabIds.clear()
  overlayStatusByTab.clear()
  void publishPlaqueCount()
}

async function injectOverlay(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['overlay/index.js'],
    injectImmediately: true,
  })
}

async function broadcastOverlay(message: ExtensionMessage): Promise<void> {
  const tabIds = overlayEnabled ? new Set([...(await overlayTargets()), ...overlayTabIds]) : overlayTabIds
  overlayTabIds = tabIds
  await Promise.all(
    [...tabIds].map(async (tabId) => {
      try {
        await chrome.tabs.sendMessage(tabId, message)
      } catch {
        await injectOverlay(tabId).catch(() => undefined)
        try {
          await chrome.tabs.sendMessage(tabId, message)
        } catch {
          // Tab cannot receive overlay messages.
        }
      }
    }),
  )
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://')
}

function isHttpTab(tab: chrome.tabs.Tab): boolean {
  return isHttpUrl(tab.url ?? tab.pendingUrl ?? '')
}

async function overlayTargets(): Promise<number[]> {
  const tabs = await chrome.tabs.query({})
  const ranked = tabs
    .filter((tab) => tab.id && isHttpTab(tab))
    .sort((left, right) => overlayScore(right) - overlayScore(left))
  return ranked.map((tab) => tab.id as number)
}

function overlayScore(tab: chrome.tabs.Tab): number {
  const url = tab.url ?? tab.pendingUrl ?? ''
  let score = 0
  if (url.includes('meet.google.com') || url.includes('zoom.us') || url.includes('teams.microsoft.com')) {
    score += 8
  }
  if (tab.audible) {
    score += 4
  }
  if (tab.active) {
    score += 2
  }
  return score
}

function enableOverlayMessage(): ExtensionMessage {
  return { type: MessageType.EnableOverlay, direction: translateDirection }
}

async function publishPlaqueCount(): Promise<void> {
  const tabs = await chrome.tabs.query({})
  const httpTabs = tabs.filter((tab) => tab.id && isHttpTab(tab))
  const preferred =
    httpTabs.find((tab) => tab.audible) ??
    httpTabs.find((tab) => tab.active) ??
    [...httpTabs].sort((left, right) => overlayScore(right) - overlayScore(left))[0]
  const status = preferred?.id !== undefined ? overlayStatusByTab.get(preferred.id) : undefined
  const count = Number(status?.original) + Number(status?.translation)
  await chrome.runtime.sendMessage({ type: MessageType.OverlayPlaqueCount, count }).catch(() => undefined)
}

async function openCaptionWindow(): Promise<void> {
  await closeCaptionWindows()
  const tabs = await chrome.tabs.query({})
  const httpTabs = tabs.filter((tab) => tab.id && isHttpTab(tab))
  if (httpTabs.length === 0) {
    throw new NamedError('overlay-no-tab', chrome.i18n.getMessage('captionsNoTab'))
  }

  overlayEnabled = true
  const errors: string[] = []
  let injected = 0
  let injectedCall = 0
  for (const tab of httpTabs.sort((left, right) => overlayScore(right) - overlayScore(left))) {
    const tabId = tab.id
    if (!tabId) {
      continue
    }
    overlayTabIds.add(tabId)
    try {
      await injectOverlay(tabId)
      await chrome.tabs.sendMessage(tabId, enableOverlayMessage()).catch(() => undefined)
      injected += 1
      if (overlayScore(tab) >= 8) {
        injectedCall += 1
      }
    } catch (error) {
      errors.push(overlayAccessError(tab, error))
    }
  }
  const callTabs = httpTabs.filter((tab) => overlayScore(tab) >= 8)
  if (callTabs.length > 0 && injectedCall === 0) {
    const first = errors[0] ?? chrome.i18n.getMessage('captionsNeedHost')
    throw new NamedError(overlayFailureCode(first, callTabs), first)
  }
  if (injected === 0) {
    const first = errors[0] ?? chrome.i18n.getMessage('captionsNeedHost')
    throw new NamedError(overlayFailureCode(first, httpTabs), first)
  }
}

function overlayFailureCode(message: string, tabs: chrome.tabs.Tab[]): string {
  if (tabs.every((tab) => tab.incognito) || message.toLowerCase().includes('incognito') || message.includes('инкогнито')) {
    return 'overlay-incognito'
  }
  return 'overlay-host'
}

function overlayAccessError(tab: chrome.tabs.Tab, error: unknown): string {
  if (tab.incognito) {
    return chrome.i18n.getMessage('captionsIncognito')
  }
  const message = errorMessage(error)
  if (message.includes('Cannot access contents') || message.includes('respective host')) {
    return chrome.i18n.getMessage('captionsNeedHost')
  }
  return `${tab.title ?? tab.url ?? String(tab.id)}: ${message}`
}

async function closeCaptionWindows(): Promise<void> {
  const windows = await chrome.windows.getAll({ populate: true })
  await Promise.all(
    windows.map(async (win) => {
      const isCaption = win.tabs?.some((tab) => tab.url?.includes('/overlay/panel.html'))
      if (isCaption && win.id !== undefined) {
        try {
          await chrome.windows.remove(win.id)
        } catch {
          // Already closed.
        }
      }
    }),
  )
}

void closeCaptionWindows()
