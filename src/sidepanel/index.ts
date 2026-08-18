import { MicrophoneSession, requestMicrophone } from './mic.js'
import { transcribeAudio, translateText } from '../shared/llm.js'
import { classifyApiError, NamedError, overlayIssueKey, type ApiFailureKind } from '../shared/errors.js'
import { MessageType } from '../shared/messages.js'
import {
  loadLlmSettings,
  loadTranslateDirection,
  saveProvider,
  saveProviderKey,
  saveTranslateDirection,
  type LlmSettings,
  type ProviderId,
  type TranslateDirection,
} from '../shared/storage.js'
import { pickTabAudio, TabAudioSession } from './tab-client.js'

const statusEl = document.getElementById('status')!
const hintEl = document.getElementById('starter-body')!
const micToggle = document.getElementById('mic-toggle') as HTMLButtonElement
const tabToggle = document.getElementById('tab-toggle') as HTMLButtonElement
const captionsToggle = document.getElementById('captions-toggle') as HTMLButtonElement
const directionToggle = document.getElementById('direction-toggle') as HTMLButtonElement
const directionTitle = document.getElementById('direction-title')!
const sidebarCaptionsToggle = document.getElementById('sidebar-captions-toggle') as HTMLButtonElement
const waveEl = document.getElementById('wave')!
const coreEl = document.getElementById('core-value')!
const linkEl = document.getElementById('link-value')!
const frameEl = document.querySelector('.frame') as HTMLElement
const originalEl = document.getElementById('tab-original')!
const translationEl = document.getElementById('tab-translation')!
const clearOriginal = document.getElementById('clear-original') as HTMLButtonElement
const clearTranslation = document.getElementById('clear-translation') as HTMLButtonElement
const apiKeyInput = document.getElementById('api-key') as HTMLInputElement
const providerSelect = document.getElementById('provider') as HTMLSelectElement
const apiKeyLabel = document.getElementById('api-key-label')!
const apiKeyHint = document.getElementById('api-key-hint')!
const signalEl = document.getElementById('signal-value')!
const waveBars = Array.from(waveEl.querySelectorAll('span'))

let settings: LlmSettings = {
  provider: 'openai',
  keys: { openai: '', groq: '', gemini: '' },
}
let whisperBusy = false
let hintLockUntil = 0
let liveIssue: { status: string; hint: string } | null = null
const whisperQueue: Blob[] = []

const mic = new MicrophoneSession({
  onLevel: paintLevel,
})

const tab = new TabAudioSession({
  onLevel: onTabLevel,
  onChunk: onTabChunk,
})

document.documentElement.lang = chrome.i18n.getUILanguage()
document.title = chrome.i18n.getMessage('extName')
document.getElementById('ext-name')!.textContent = chrome.i18n.getMessage('extName')
document.getElementById('api-key-label')!.textContent = chrome.i18n.getMessage('apiKeyLabel')
document.getElementById('provider-label')!.textContent = chrome.i18n.getMessage('providerLabel')
statusEl.textContent = chrome.i18n.getMessage('statusStandby')
statusEl.title = statusEl.textContent
writeHint(chrome.i18n.getMessage('micIdleHint'))
labelButton(captionsToggle, 'captionsOpen')
labelButton(clearOriginal, 'clearOriginal')
labelButton(clearTranslation, 'clearTranslation')
setSourceState(micToggle, false)
setSourceState(tabToggle, false)

let hideSidebarCaptions = true
let overlayPlaques = 0
let translateDirection: TranslateDirection = 'en-ru'
syncLayout()
syncCaptionsButton()
syncDirectionUi()
void chrome.runtime.sendMessage({ type: MessageType.RequestPlaqueCount }).catch(() => undefined)

void chrome.storage.local.get({ sidebarCaptionsHidden: true }).then((stored) => {
  hideSidebarCaptions = stored.sidebarCaptionsHidden !== false
  syncLayout()
})

void loadTranslateDirection().then((value) => {
  translateDirection = value
  syncDirectionUi()
})

void loadLlmSettings().then((value) => {
  settings = value
  providerSelect.value = settings.provider
  syncProviderUi()
})

micToggle.addEventListener('click', () => {
  if (mic.active) {
    void stopMicListening()
    return
  }

  statusEl.classList.remove('error')
  statusEl.textContent = chrome.i18n.getMessage('statusRequesting')
  writeHint(chrome.i18n.getMessage('micRequestHint'))
  micToggle.disabled = true
  const streamPromise = requestMicrophone()
  void startMicListening(streamPromise)
})

tabToggle.addEventListener('click', () => {
  if (tab.active) {
    void stopTabListening()
    return
  }

  clearLiveIssue()
  const overlayPromise = enableOnScreenCaptions()
  const streamPromise = pickTabAudio()
  statusEl.classList.remove('error')
  statusEl.textContent = chrome.i18n.getMessage('statusTabRequesting')
  writeHint(chrome.i18n.getMessage('tabRequestHint'))
  tabToggle.disabled = true
  void startTabListening(streamPromise, overlayPromise)
})

captionsToggle.addEventListener('click', () => {
  void enableOnScreenCaptions()
    .then(() => {
      clearLiveIssue()
      setHint(chrome.i18n.getMessage('captionsOpened'), 12000)
    })
    .catch((error: unknown) => {
      reportOverlayIssue(error)
    })
})

sidebarCaptionsToggle.addEventListener('click', () => {
  hideSidebarCaptions = !hideSidebarCaptions
  void chrome.storage.local.set({ sidebarCaptionsHidden: hideSidebarCaptions })
  syncLayout()
})

directionToggle.addEventListener('click', () => {
  translateDirection = translateDirection === 'en-ru' ? 'ru-en' : 'en-ru'
  void saveTranslateDirection(translateDirection)
  syncDirectionUi()
  void chrome.runtime.sendMessage({
    type: MessageType.SetTranslateDirection,
    direction: translateDirection,
  })
})

clearOriginal.addEventListener('click', () => {
  requestCaptionClear('original')
})

clearTranslation.addEventListener('click', () => {
  requestCaptionClear('translation')
})

apiKeyInput.addEventListener('change', persistApiKey)
apiKeyInput.addEventListener('input', persistApiKey)
providerSelect.addEventListener('change', () => {
  const next = providerSelect.value as ProviderId
  const previous = settings.provider
  settings.keys[previous] = apiKeyInput.value.trim()
  void saveProviderKey(previous, settings.keys[previous])
  settings.provider = next
  void saveProvider(next)
  syncProviderUi()
})

chrome.runtime.onMessage.addListener((message: { type?: string; count?: number; target?: 'original' | 'translation' }) => {
  if (message.type === MessageType.OverlayPlaqueCount && typeof message.count === 'number') {
    setOverlayPlaques(message.count)
  }
  if (message.type === MessageType.ClearOverlayCaption) {
    clearCaptionBoxes(message.target)
  }
})

window.addEventListener('unload', () => {
  void mic.stop()
  void tab.stop()
  void sendOverlay({ type: MessageType.DisableOverlay })
})

async function startMicListening(streamPromise: Promise<MediaStream>): Promise<void> {
  const popupTimer = window.setTimeout(() => {
    writeHint(chrome.i18n.getMessage('grantBody'))
    void chrome.windows.create({
      url: chrome.runtime.getURL('permission/index.html'),
      type: 'popup',
      width: 420,
      height: 320,
      focused: true,
    })
  }, 1800)

  try {
    const stream = await streamPromise
    window.clearTimeout(popupTimer)
    await mic.attach(stream)
    setMicUi(true)
  } catch (error) {
    window.clearTimeout(popupTimer)
    try {
      await grantMicrophoneInPopup()
      const stream = await requestMicrophone()
      await mic.attach(stream)
      setMicUi(true)
    } catch {
      const denied = error instanceof DOMException && error.name === 'NotAllowedError'
      setMicUi(false)
      showError(denied ? 'micDenied' : 'micError')
    }
  } finally {
    micToggle.disabled = false
  }
}

async function stopMicListening(): Promise<void> {
  await mic.stop()
  setMicUi(false)
}

async function startTabListening(
  streamPromise: Promise<MediaStream>,
  overlayPromise: Promise<void>,
): Promise<void> {
  const overlayResult = overlayPromise.then(() => true).catch((error: unknown) => error)
  try {
    originalEl.replaceChildren()
    translationEl.replaceChildren()
    const stream = await streamPromise
    await tab.attach(stream)
    setTabUi(true)
  } catch (error) {
    await tab.stop()
    setTabUi(false)
    void sendOverlay({ type: MessageType.DisableOverlay })
    const detail = error instanceof Error ? error.message : undefined
    if (detail === 'NO_TAB_AUDIO') {
      showError('tabNoAudio')
    } else {
      showError('tabError', detail)
    }
    return
  } finally {
    tabToggle.disabled = false
  }

  const overlay = await overlayResult
  if (!tab.active) {
    return
  }
  if (overlay !== true) {
    reportOverlayIssue(overlay)
  } else {
    setHint(chrome.i18n.getMessage('captionsOpened'), 8000)
  }
}

async function stopTabListening(): Promise<void> {
  clearLiveIssue()
  await tab.stop()
  setTabUi(false)
  void sendOverlay({ type: MessageType.DisableOverlay })
}

function onTabLevel(level: number, bands: number[]): void {
  if (!tab.active) {
    return
  }
  paintLevel(level, bands)
  signalEl.textContent = `${Math.round(level * 100)}%`
  if (!whisperBusy && Date.now() >= hintLockUntil && !liveIssue && !statusEl.classList.contains('error')) {
    writeHint(
      chrome.i18n.getMessage(!currentKey() ? 'tabNeedsKey' : level < 0.04 ? 'tabSilent' : 'tabLiveHint'),
    )
  }
}

function onTabChunk(blob: Blob, _rms: number): void {
  persistApiKey()
  if (!currentKey()) {
    setHint(chrome.i18n.getMessage('tabNeedsKey'), 8000)
    return
  }
  whisperQueue.push(blob)
  if (whisperQueue.length > 4) {
    whisperQueue.shift()
  }
  void drainWhisperQueue()
}

async function drainWhisperQueue(): Promise<void> {
  if (whisperBusy) {
    return
  }

  whisperBusy = true
  while (whisperQueue.length > 0) {
    const blob = whisperQueue.shift()
    if (!blob) {
      break
    }
    try {
      setHint(chrome.i18n.getMessage(translateDirection === 'en-ru' ? 'tabTranscribingEn' : 'tabTranscribingRu'))
      const original = await transcribeAudio(settings.provider, currentKey(), blob, translateDirection)
      if (!original) {
        setHint(chrome.i18n.getMessage(translateDirection === 'en-ru' ? 'tabWaitingSpeechEn' : 'tabWaitingSpeechRu'))
        continue
      }
      appendCaption(originalEl, original)
      void sendOverlay({
        type: MessageType.ShowOverlayCaption,
        original,
        translation: '',
      })
      setHint(chrome.i18n.getMessage(translateDirection === 'en-ru' ? 'tabTranslatingRu' : 'tabTranslatingEn'))
      try {
        const translated = await translateText(settings.provider, currentKey(), original, translateDirection)
        if (!translated) {
          reportLlmIssue('translate', 'empty')
          continue
        }
        appendCaption(translationEl, translated)
        void sendOverlay({
          type: MessageType.ShowOverlayCaption,
          original,
          translation: translated,
        })
        clearLiveIssue()
        setHint(chrome.i18n.getMessage('tabLiveHint'))
      } catch (error) {
        reportLlmIssue('translate', classifyApiError(error), error)
      }
    } catch (error) {
      reportLlmIssue('transcribe', classifyApiError(error), error)
    }
  }
  whisperBusy = false
}

function grantMicrophoneInPopup(): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: { type?: string }) => {
      if (message.type === 'MIC_PERMISSION_GRANTED') {
        chrome.runtime.onMessage.removeListener(onMessage)
        resolve()
      }
      if (message.type === 'MIC_PERMISSION_DENIED') {
        chrome.runtime.onMessage.removeListener(onMessage)
        reject(new DOMException('Permission denied', 'NotAllowedError'))
      }
    }

    chrome.runtime.onMessage.addListener(onMessage)
    void chrome.windows.create({
      url: chrome.runtime.getURL('permission/index.html'),
      type: 'popup',
      width: 420,
      height: 320,
      focused: true,
    })
  })
}

function sendOverlay(
  message:
    | { type: typeof MessageType.EnableOverlay; direction?: TranslateDirection }
    | { type: typeof MessageType.DisableOverlay }
    | { type: typeof MessageType.ShowOverlayCaption; original: string; translation: string }
    | { type: typeof MessageType.ClearOverlayCaption; target?: 'original' | 'translation' }
    | { type: typeof MessageType.SetTranslateDirection; direction: TranslateDirection },
): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined)
}

function clearCaptionBoxes(target?: 'original' | 'translation'): void {
  if (target !== 'translation') {
    originalEl.replaceChildren()
  }
  if (target !== 'original') {
    translationEl.replaceChildren()
  }
}

function requestCaptionClear(target?: 'original' | 'translation'): void {
  clearCaptionBoxes(target)
  sendOverlay({ type: MessageType.ClearOverlayCaption, target })
}

async function enableOnScreenCaptions(): Promise<void> {
  let granted = false
  try {
    granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })
  } catch {
    granted = false
  }
  if (!granted) {
    const allowed = await chrome.permissions
      .contains({ origins: ['https://*/*'] })
      .catch(() => false)
    if (!allowed) {
      throw new NamedError('overlay-denied', chrome.i18n.getMessage('issueOverlayDenied'))
    }
  }
  await openCaptionWindow()
}

async function openCaptionWindow(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: MessageType.OpenCaptionWindow,
    direction: translateDirection,
  })) as { ok: true } | { ok: false; error?: string; code?: string } | undefined
  if (!response || response.ok === false) {
    throw new NamedError(
      response?.code ?? 'overlay-host',
      response?.error ?? chrome.i18n.getMessage('issueOverlayUnknown'),
    )
  }
}

function syncLayout(): void {
  document.body.classList.toggle('hide-captions', hideSidebarCaptions)
  sidebarCaptionsToggle.classList.toggle('active', !hideSidebarCaptions)
  sidebarCaptionsToggle.setAttribute('aria-pressed', String(!hideSidebarCaptions))
  labelButton(sidebarCaptionsToggle, hideSidebarCaptions ? 'sidebarCaptionsShow' : 'sidebarCaptionsHide')
}

function setOverlayPlaques(count: number): void {
  overlayPlaques = Math.max(0, Math.min(2, count))
  syncCaptionsButton()
}

function syncCaptionsButton(): void {
  captionsToggle.hidden = overlayPlaques >= 2
}

function syncDirectionUi(): void {
  const enToRu = translateDirection === 'en-ru'
  directionTitle.textContent = chrome.i18n.getMessage(enToRu ? 'directionEnRu' : 'directionRuEn')
  labelButton(directionToggle, enToRu ? 'directionHintEnRu' : 'directionHintRuEn')
  document.getElementById('original-label')!.textContent = chrome.i18n.getMessage(
    enToRu ? 'originalLabel' : 'translationLabel',
  )
  document.getElementById('translation-label')!.textContent = chrome.i18n.getMessage(
    enToRu ? 'translationLabel' : 'originalLabel',
  )
}

function persistApiKey(): void {
  settings.keys[settings.provider] = apiKeyInput.value.trim()
  void saveProviderKey(settings.provider, currentKey())
}

function currentKey(): string {
  return settings.keys[settings.provider]?.trim() ?? ''
}

function providerTitle(): string {
  return settings.provider === 'openai' ? 'OpenAI' : settings.provider === 'groq' ? 'Groq' : 'Gemini'
}

function llmIssueKey(stage: 'transcribe' | 'translate', kind: ApiFailureKind | 'empty'): string {
  if (kind === 'empty') {
    return 'issueTranslateEmpty'
  }
  const suffix =
    kind === 'badKey'
      ? 'BadKey'
      : kind === 'quota'
        ? 'Quota'
        : kind === 'rateLimit'
          ? 'RateLimit'
          : kind === 'modelGone'
            ? 'ModelGone'
            : kind === 'network'
              ? 'Network'
              : 'Unknown'
  return stage === 'transcribe' ? `issueTranscribe${suffix}` : `issueTranslate${suffix}`
}

function reportLlmIssue(stage: 'transcribe' | 'translate', kind: ApiFailureKind | 'empty', error?: unknown): void {
  const key = llmIssueKey(stage, kind)
  const fallback = stage === 'transcribe' ? 'issueTranscribeUnknown' : 'issueTranslateUnknown'
  const template = chrome.i18n.getMessage(key) || chrome.i18n.getMessage(fallback)
  const hint = template
    .replaceAll('{provider}', providerTitle())
    .replaceAll('{detail}', error instanceof Error ? error.message : '')
  setLiveIssue(stage === 'transcribe' ? 'statusNoTranscript' : 'statusNoTranslation', hint)
}

function reportOverlayIssue(error: unknown): void {
  setLiveIssue('statusOverlayMissing', chrome.i18n.getMessage(overlayIssueKey(error)))
}

function setLiveIssue(statusKey: string, hint: string): void {
  liveIssue = {
    status: chrome.i18n.getMessage(statusKey),
    hint,
  }
  paintLiveIssue()
}

function paintLiveIssue(): void {
  if (!liveIssue) {
    return
  }
  statusEl.textContent = liveIssue.status
  statusEl.title = liveIssue.status
  statusEl.classList.add('error')
  writeHint(liveIssue.hint, true)
  hintLockUntil = Date.now() + 45000
}

function clearLiveIssue(): void {
  liveIssue = null
}

function syncProviderUi(): void {
  providerSelect.value = settings.provider
  apiKeyInput.value = currentKey()
  const suffix =
    settings.provider === 'openai' ? 'Openai' : settings.provider === 'groq' ? 'Groq' : 'Gemini'
  apiKeyLabel.textContent = chrome.i18n.getMessage(`apiKeyLabel${suffix}`)
  apiKeyHint.textContent = chrome.i18n.getMessage(`apiKeyHint${suffix}`)
  apiKeyHint.title = apiKeyHint.textContent
}

function writeHint(text: string, isError = false): void {
  hintEl.textContent = text
  hintEl.title = text
  hintEl.classList.toggle('error', isError)
  hintEl.scrollTop = 0
}

function setHint(text: string, lockMs = 0): void {
  writeHint(text)
  hintLockUntil = lockMs ? Date.now() + lockMs : 0
}

function labelButton(button: HTMLButtonElement, messageKey: string): void {
  const label = chrome.i18n.getMessage(messageKey)
  button.title = label
  button.setAttribute('aria-label', label)
}

function paintLevel(level: number, bands: number[]): void {
  frameEl.classList.add('live')
  waveEl.classList.add('live')
  frameEl.style.setProperty('--level', String(level))
  waveBars.forEach((bar, index) => {
    const value = bands[index] ?? level
    bar.style.height = `${4 + value * 12}px`
    bar.style.opacity = String(0.4 + value * 0.6)
  })
}

function setMicUi(on: boolean): void {
  if (!tab.active) {
    frameEl.classList.toggle('live', on)
    waveEl.classList.toggle('live', on)
    coreEl.textContent = on ? 'LIVE' : 'IDLE'
    statusEl.classList.toggle('error', false)
    statusEl.textContent = chrome.i18n.getMessage(on ? 'statusListening' : 'statusStandby')
    statusEl.title = statusEl.textContent
    writeHint(chrome.i18n.getMessage(on ? 'micLiveHint' : 'micIdleHint'))
    if (!on) {
      clearWave()
    }
  }
  micToggle.classList.toggle('listening', on)
  setSourceState(micToggle, on)
}

function setTabUi(on: boolean): void {
  frameEl.classList.toggle('live', on || mic.active)
  waveEl.classList.toggle('live', on || mic.active)
  tabToggle.classList.toggle('listening', on)
  setSourceState(tabToggle, on)
  labelButton(tabToggle, on ? 'stopTab' : 'tabTitle')
  if (on) {
    tabToggle.title = `${chrome.i18n.getMessage('stopTab')} — ${chrome.i18n.getMessage('tabStopKicker')}`
  }
  linkEl.textContent = on ? 'TAB' : 'LOCAL'
  coreEl.textContent = on || mic.active ? 'LIVE' : 'IDLE'
  if (on) {
    if (liveIssue) {
      paintLiveIssue()
    } else {
      statusEl.classList.toggle('error', false)
      statusEl.textContent = chrome.i18n.getMessage('statusTabListening')
      statusEl.title = statusEl.textContent
      writeHint(chrome.i18n.getMessage(currentKey() ? 'tabLiveHint' : 'tabNeedsKey'))
    }
  } else if (!mic.active) {
    statusEl.textContent = chrome.i18n.getMessage('statusStandby')
    statusEl.title = statusEl.textContent
    writeHint(chrome.i18n.getMessage('micIdleHint'))
    signalEl.textContent = '--'
    clearWave()
  }
}

function setSourceState(button: HTMLButtonElement, on: boolean): void {
  button.setAttribute('aria-pressed', String(on))
  const key = button === tabToggle ? (on ? 'stopTab' : 'tabTitle') : on ? 'stop' : 'micTitle'
  labelButton(button, key)
}

function showError(key: string, detail?: string): void {
  const text = detail ? `${chrome.i18n.getMessage(key)}: ${detail}` : chrome.i18n.getMessage(key)
  statusEl.textContent = chrome.i18n.getMessage(key)
  statusEl.title = text
  statusEl.classList.add('error')
  writeHint(text, true)
}

function isNearBottom(host: HTMLElement): boolean {
  return host.scrollHeight - host.scrollTop - host.clientHeight < 48
}

function followBottom(host: HTMLElement, durationMs = 520): void {
  const started = performance.now()
  const tick = (now: number) => {
    host.scrollTop = host.scrollHeight
    if (now - started < durationMs) {
      requestAnimationFrame(tick)
    }
  }
  requestAnimationFrame(tick)
}

function appendCaption(host: HTMLElement, text: string): void {
  const stick = isNearBottom(host)
  const line = document.createElement('p')
  line.className = 'caption-line'
  const inner = document.createElement('span')
  inner.textContent = text
  line.append(inner)
  host.append(line)
  requestAnimationFrame(() => {
    line.classList.add('in')
  })
  if (stick) {
    followBottom(host)
  }
}

function clearWave(): void {
  waveBars.forEach((bar) => {
    bar.style.height = ''
    bar.style.opacity = ''
  })
}
