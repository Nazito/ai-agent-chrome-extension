import { NamedError } from './shared/errors.js'
import { type CaptureSource, type CommandResponse, type ExtensionMessage, MessageType } from './shared/messages.js'
import { isTranslateDirection, type TranslateDirection } from './shared/storage.js'

let overlayTabIds = new Set<number>()
let overlayEnabled = false
let sidePanelVisible = false
let hideOverlayTimer = 0
let translateDirection: TranslateDirection = 'en-ru'
const overlayStatusByTab = new Map<number, { original: boolean; translation: boolean }>()
const OVERLAY_SEND_MS = 700
const OVERLAY_INJECT_MS = 1200
const overlayBoot = Promise.race([
  restoreOverlaySession(),
  new Promise<void>((resolve) => {
    setTimeout(resolve, 400)
  }),
])

type OverlaySession = {
  enabled: boolean
  tabIds: number[]
  direction: TranslateDirection
}

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

let sidePanelPorts = 0
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'jarvis-sidepanel') {
    return
  }
  sidePanelPorts += 1
  windowClearHideTimer()
  port.onDisconnect.addListener(() => {
    sidePanelPorts = Math.max(0, sidePanelPorts - 1)
    if (sidePanelPorts > 0) {
      return
    }
    hideOverlayTimer = setTimeout(() => {
      hideOverlayTimer = 0
      if (sidePanelPorts > 0 || sidePanelVisible) {
        return
      }
      void hideOverlaysIfSidePanelClosed()
    }, 250) as unknown as number
  })
})

function windowClearHideTimer(): void {
  if (hideOverlayTimer) {
    clearTimeout(hideOverlayTimer)
    hideOverlayTimer = 0
  }
}

void overlayBoot.then(() => {
  void hideOverlaysIfSidePanelClosed()
})

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.id || !isHttpTab(tab)) {
    return
  }
  void overlayBoot.then(() => {
    if (!overlayEnabled) {
      return
    }
    if (overlayTabIds.has(tabId) || tab.audible || tab.active) {
      overlayTabIds.add(tabId)
      persistOverlaySession()
      void ensureOverlay(tabId)
    }
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  overlayTabIds.delete(tabId)
  overlayStatusByTab.delete(tabId)
  persistOverlaySession()
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

    if (message.type === MessageType.GetTabStreamId) {
      chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId }, (streamId) => {
        const error = chrome.runtime.lastError
        if (error?.message || !streamId) {
          sendResponse({ ok: false, error: error?.message ?? chrome.i18n.getMessage('tabNoStream') })
          return
        }
        sendResponse({ ok: true, streamId })
      })
      return true
    }

    if (message.type === MessageType.SidePanelPresence) {
      windowClearHideTimer()
      sidePanelVisible = message.visible === true
      if (sidePanelVisible) {
        sidePanelPorts = Math.max(sidePanelPorts, 1)
        void chrome.storage.local.set({ sidePanelOpen: true })
      } else {
        void hideOverlaysIfSidePanelClosed()
      }
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.EnableOverlay) {
      void overlayBoot.then(async () => {
        if (!(await sidePanelIsOpen())) {
          return
        }
        if (isTranslateDirection(message.direction)) {
          translateDirection = message.direction
        }
        if (overlayEnabled) {
          await pingOverlay()
        } else {
          await enableOverlay()
        }
      })
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.DisableOverlay) {
      void overlayBoot.then(() => disableOverlay())
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.ShowOverlayCaption) {
      void overlayBoot.then(() => enqueueOverlay(message))
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.ClearOverlayCaption) {
      void overlayBoot.then(() => enqueueOverlay(message))
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
      overlayBoot
        .then(() => openCaptionWindow())
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
        persistOverlaySession()
        void enqueueOverlay({ type: MessageType.SetTranslateDirection, direction: translateDirection })
      }
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.CloseCaptionWindow) {
      overlayBoot
        .then(() => disableOverlay())
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

    if (
      message.type === MessageType.ShowOverlayQuestion ||
      message.type === MessageType.ShowOverlayAnswer
    ) {
      void overlayBoot.then(() => enqueueOverlay(message))
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.ClearOverlayQuestions) {
      if (sender.tab) {
        void chrome.runtime.sendMessage(message).catch(() => undefined)
      }
      void overlayBoot.then(() => enqueueOverlay(message))
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.CloseOverlayPlaque) {
      if (sender.tab) {
        void chrome.runtime.sendMessage(message).catch(() => undefined)
      }
      void overlayBoot.then(() => enqueueOverlay(message))
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.DismissOverlayQuestion) {
      if (sender.tab) {
        void chrome.runtime.sendMessage(message).catch(() => undefined)
      }
      void overlayBoot.then(() => enqueueOverlay(message))
      sendResponse({ ok: true })
      return false
    }

    if (message.type === MessageType.RequestOverlayAnswer) {
      if (sender.tab) {
        void chrome.runtime.sendMessage(message).catch(() => undefined)
      }
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
  sidePanelVisible = true
  windowClearHideTimer()
  void chrome.storage.local.set({ sidePanelOpen: true })
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
      persistOverlaySession()
      try {
        await injectOverlay(tab.id)
        await chrome.tabs.sendMessage(tab.id, enableOverlayMessage(), { frameId: 0 }).catch(() => undefined)
      } catch {
        // Site access may still block this tab.
      }
    }
  }
}

async function restoreOverlaySession(): Promise<void> {
  try {
    if (!(await sidePanelIsOpen())) {
      overlayEnabled = false
      persistOverlaySession()
      return
    }
    const stored = (await chrome.storage.session.get('overlaySession')) as {
      overlaySession?: OverlaySession
    }
    const session = stored.overlaySession
    if (!session?.enabled) {
      return
    }
    overlayEnabled = true
    overlayTabIds = new Set(session.tabIds.filter((id) => Number.isInteger(id) && id > 0))
    if (isTranslateDirection(session.direction)) {
      translateDirection = session.direction
    }
  } catch {
    // session storage may be unavailable
  }
}

async function sidePanelIsOpen(): Promise<boolean> {
  return sidePanelVisible
}

async function hideOverlaysIfSidePanelClosed(): Promise<void> {
  if (await sidePanelIsOpen()) {
    return
  }
  sidePanelVisible = false
  void chrome.storage.local.set({ sidePanelOpen: false })
  await disableOverlay()
}

function persistOverlaySession(): void {
  void chrome.storage.session
    .set({
      overlaySession: {
        enabled: overlayEnabled,
        tabIds: [...overlayTabIds],
        direction: translateDirection,
      } satisfies OverlaySession,
    })
    .catch(() => undefined)
}

async function enableOverlay(): Promise<void> {
  overlayEnabled = true
  overlayTabIds = new Set(await overlayTargets())
  persistOverlaySession()
  await Promise.all([...overlayTabIds].map((tabId) => injectOverlay(tabId).catch(() => undefined)))
  await enqueueOverlay(enableOverlayMessage())
}

async function pingOverlay(): Promise<void> {
  overlayEnabled = true
  persistOverlaySession()
  await enqueueOverlay(enableOverlayMessage())
}

async function disableOverlay(): Promise<void> {
  overlayEnabled = false
  persistOverlaySession()
  await enqueueOverlay({ type: MessageType.DisableOverlay })
  const tabIds = await allHttpTabIds()
  await Promise.all(tabIds.map((tabId) => hideOverlayDom(tabId)))
  overlayTabIds.clear()
  overlayStatusByTab.clear()
  persistOverlaySession()
  void publishPlaqueCount()
}

async function injectOverlay(tabId: number): Promise<void> {
  await withTimeout(
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ['overlay/index.js'],
        injectImmediately: true,
      })
      .then(() => undefined),
    OVERLAY_INJECT_MS,
  )
}

async function hideOverlayDom(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => {
        const hud = (window as Window & { __jarvisHud?: { hide?: () => void } }).__jarvisHud
        if (typeof hud?.hide === 'function') {
          hud.hide()
          return
        }
        for (const id of [
          'jarvis-plaque-original',
          'jarvis-plaque-translation',
          'jarvis-plaque-questions',
        ]) {
          const host = document.getElementById(id)
          if (host) {
            host.style.setProperty('display', 'none', 'important')
          }
        }
      },
    })
    .catch(() => undefined)
}

async function ensureOverlay(tabId: number): Promise<void> {
  try {
    await injectOverlay(tabId)
    await sendToFrame(tabId, enableOverlayMessage())
  } catch {
    // Site access or missing receiver.
  }
}

async function sendOverlayToTab(tabId: number, message: ExtensionMessage): Promise<void> {
  await withTimeout(deliverOverlayToTab(tabId, message), OVERLAY_SEND_MS + OVERLAY_INJECT_MS + OVERLAY_SEND_MS).catch(
    () => undefined,
  )
}

async function deliverOverlayToTab(tabId: number, message: ExtensionMessage): Promise<void> {
  try {
    await sendToFrame(tabId, message)
  } catch {
    if (!overlayEnabled && message.type !== MessageType.DisableOverlay) {
      return
    }
    await injectOverlay(tabId)
    if (message.type !== MessageType.EnableOverlay && message.type !== MessageType.DisableOverlay) {
      await sendToFrame(tabId, enableOverlayMessage()).catch(() => undefined)
    }
    await sendToFrame(tabId, message)
  }
}

function sendToFrame(tabId: number, message: ExtensionMessage): Promise<unknown> {
  return withTimeout(chrome.tabs.sendMessage(tabId, message, { frameId: 0 }), OVERLAY_SEND_MS)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('overlay-timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

let overlayQueue: Promise<void> = Promise.resolve()

function enqueueOverlay(message: ExtensionMessage): Promise<void> {
  const live =
    message.type === MessageType.ShowOverlayQuestion ||
    message.type === MessageType.ShowOverlayAnswer ||
    message.type === MessageType.DismissOverlayQuestion ||
    message.type === MessageType.ClearOverlayQuestions ||
    message.type === MessageType.CloseOverlayPlaque
  if (live) {
    return overlayBoot.then(() => broadcastOverlay(message)).catch(() => undefined)
  }
  overlayQueue = overlayQueue.then(() => broadcastOverlay(message)).catch(() => undefined)
  return overlayQueue
}

async function broadcastOverlay(message: ExtensionMessage): Promise<void> {
  await overlayBoot
  if (
    !overlayEnabled &&
    (message.type === MessageType.ShowOverlayCaption ||
      message.type === MessageType.ShowOverlayQuestion ||
      message.type === MessageType.ShowOverlayAnswer)
  ) {
    if (!sidePanelVisible) {
      return
    }
    overlayEnabled = true
    persistOverlaySession()
  }
  const fanOut =
    message.type === MessageType.DisableOverlay ||
    message.type === MessageType.ClearOverlayQuestions ||
    message.type === MessageType.CloseOverlayPlaque
  const tabIds = fanOut ? await allHttpTabIds() : overlayEnabled ? await overlayTargets() : []
  if (message.type !== MessageType.DisableOverlay && overlayEnabled) {
    overlayTabIds = new Set(tabIds)
    persistOverlaySession()
  }
  await Promise.all(tabIds.map((tabId) => sendOverlayToTab(tabId, message)))
}

async function allHttpTabIds(): Promise<number[]> {
  const tabs = await chrome.tabs.query({})
  return tabs.filter((tab) => tab.id && isHttpTab(tab)).map((tab) => tab.id as number)
}

function isHttpUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://')
}

function isHttpTab(tab: chrome.tabs.Tab): boolean {
  return isHttpUrl(tab.url ?? tab.pendingUrl ?? '')
}

async function overlayTargets(): Promise<number[]> {
  const tabs = await chrome.tabs.query({})
  const ids = new Set<number>()
  for (const tab of tabs) {
    if (!tab.id || !isHttpTab(tab)) {
      continue
    }
    if (overlayTabIds.has(tab.id) || tab.audible || tab.active || overlayScore(tab) >= 8) {
      ids.add(tab.id)
    }
  }
  if (ids.size > 0) {
    return [...ids]
  }
  const fallback = tabs
    .filter((tab) => tab.id && isHttpTab(tab))
    .sort((left, right) => overlayScore(right) - overlayScore(left))[0]?.id
  return fallback ? [fallback] : []
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
  sidePanelVisible = true
  windowClearHideTimer()
  await closeCaptionWindows()
  const tabs = await chrome.tabs.query({})
  const httpTabs = tabs.filter((tab) => tab.id && isHttpTab(tab))
  if (httpTabs.length === 0) {
    throw new NamedError('overlay-no-tab', chrome.i18n.getMessage('captionsNoTab'))
  }

  overlayEnabled = true
  persistOverlaySession()
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
      await sendToFrame(tabId, enableOverlayMessage()).catch(() => undefined)
      injected += 1
      if (overlayScore(tab) >= 8) {
        injectedCall += 1
      }
    } catch (error) {
      errors.push(overlayAccessError(tab, error))
    }
  }
  persistOverlaySession()
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
