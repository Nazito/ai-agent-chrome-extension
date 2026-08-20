import { MicrophoneSession, requestMicrophone } from './mic.js'
import { answerQuestion, extractQuestions, transcribeAudio, translateText } from '../shared/llm.js'
import { classifyApiError, NamedError, overlayIssueKey, type ApiFailureKind } from '../shared/errors.js'
import { MessageType } from '../shared/messages.js'
import {
  loadLlmSettings,
  loadTranslateDirection,
  saveProvider,
  saveProviderKey,
  uiLanguage,
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
const sidebarCaptionsToggle = document.getElementById('sidebar-captions-toggle') as HTMLButtonElement
const waveEl = document.getElementById('wave') as HTMLCanvasElement
const waveCtx = waveEl.getContext('2d')!
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

const WAVE_POINTS = 48
const waveDisplay = new Float32Array(WAVE_POINTS).fill(0.1)
let waveLive = false
let waveBands: number[] = []
let waveLevel = 0
let waveWidth = 0
let waveHeight = 0

let settings: LlmSettings = {
  provider: 'openai',
  keys: { openai: '', groq: '', gemini: '' },
}
let whisperBusy = false
let extractBusy = false
let hintLockUntil = 0
let liveIssue: { status: string; hint: string } | null = null
const whisperQueue: Blob[] = []
const meetingBuffer: string[] = []
const dismissedQuestions = new Set<string>()
const visibleQuestions: Array<{ id: string; text: string; key: string }> = []
let questionSeq = 0
const MEETING_BUFFER_MAX = 15
const VISIBLE_QUESTIONS_MAX = 8
const QUESTION_GATE =
  /[?？]|(?:^|[^\p{L}])(?:what|why|how|who|when|which|where|whose|whom|can you|could you|would you|will you|do you|did you|is there|are there|should we|shall we|кто|что|как|почему|зачем|когда|где|какой|какая|какие|можно ли|есть ли)(?:$|[^\p{L}])/iu

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
reportSidePanel()
window.addEventListener('resize', reportSidePanel)
window.addEventListener('pagehide', () => {
  void chrome.storage.local.set({ sidePanelOpen: false })
})
document.addEventListener('visibilitychange', () => {
  void chrome.storage.local.set({
    sidePanelOpen: document.visibilityState === 'visible',
    sidePanelWidth: Math.round(window.innerWidth),
  })
})

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
  const hostPermission = requestHostPermission()
  const streamPromise = pickTabAudio()
  statusEl.classList.remove('error')
  statusEl.textContent = chrome.i18n.getMessage('statusTabRequesting')
  writeHint(chrome.i18n.getMessage('tabRequestHint'))
  tabToggle.disabled = true
  void startTabListening(streamPromise, hostPermission)
})

captionsToggle.addEventListener('click', () => {
  void enableOnScreenCaptions()
    .then(() => {
      clearLiveIssue()
      replayOverlayQuestions()
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

chrome.runtime.onMessage.addListener(
  (message: { type?: string; count?: number; target?: 'original' | 'translation'; id?: string }) => {
    if (message.type === MessageType.OverlayPlaqueCount && typeof message.count === 'number') {
      setOverlayPlaques(message.count)
    }
    if (message.type === MessageType.ClearOverlayCaption) {
      clearCaptionBoxes(message.target)
    }
    if (message.type === MessageType.DismissOverlayQuestion && message.id) {
      dismissQuestion(message.id)
    }
    if (message.type === MessageType.RequestOverlayAnswer && message.id) {
      void answerOverlayQuestion(message.id)
    }
  },
)

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
  hostPermission: Promise<void>,
): Promise<void> {
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

  try {
    await hostPermission
    await openCaptionWindow()
    if (!tab.active) {
      return
    }
    replayOverlayQuestions()
    setHint(chrome.i18n.getMessage('captionsOpened'), 8000)
  } catch (error) {
    if (tab.active) {
      reportOverlayIssue(error)
    }
  }
}

async function stopTabListening(): Promise<void> {
  clearLiveIssue()
  resetQuestions()
  await tab.stop()
  setTabUi(false)
  void sendOverlay({ type: MessageType.ClearOverlayQuestions })
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
      void detectQuestions(original)
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
    | { type: typeof MessageType.SetTranslateDirection; direction: TranslateDirection }
    | { type: typeof MessageType.ShowOverlayQuestion; id: string; question: string }
    | { type: typeof MessageType.DismissOverlayQuestion; id: string }
    | { type: typeof MessageType.ShowOverlayAnswer; id: string; answer?: string; error?: string }
    | { type: typeof MessageType.ClearOverlayQuestions },
): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined)
}

function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function isDuplicateQuestion(key: string): boolean {
  if (dismissedQuestions.has(key)) {
    return true
  }
  return visibleQuestions.some((item) => {
    if (item.key === key) {
      return true
    }
    const shorter = item.key.length < key.length ? item.key : key
    const longer = item.key.length < key.length ? key : item.key
    return longer.includes(shorter) && shorter.length / longer.length > 0.72
  })
}

function resetQuestions(): void {
  meetingBuffer.length = 0
  dismissedQuestions.clear()
  visibleQuestions.length = 0
  questionSeq = 0
}

function replayOverlayQuestions(): void {
  for (const item of visibleQuestions) {
    sendOverlay({ type: MessageType.ShowOverlayQuestion, id: item.id, question: item.text })
  }
}

function dismissQuestion(id: string): void {
  if (id === '*') {
    for (const item of visibleQuestions) {
      dismissedQuestions.add(item.key)
    }
    visibleQuestions.length = 0
    return
  }
  const index = visibleQuestions.findIndex((item) => item.id === id)
  if (index < 0) {
    return
  }
  dismissedQuestions.add(visibleQuestions[index].key)
  visibleQuestions.splice(index, 1)
}

function pushVisibleQuestion(text: string): void {
  const key = normalizeQuestion(text)
  if (key.length < 8 || isDuplicateQuestion(key)) {
    return
  }
  const item = { id: `q-${++questionSeq}`, text, key }
  visibleQuestions.push(item)
  while (visibleQuestions.length > VISIBLE_QUESTIONS_MAX) {
    const dropped = visibleQuestions.shift()
    if (dropped) {
      sendOverlay({ type: MessageType.DismissOverlayQuestion, id: dropped.id })
    }
  }
  sendOverlay({ type: MessageType.ShowOverlayQuestion, id: item.id, question: item.text })
}

async function detectQuestions(original: string): Promise<void> {
  meetingBuffer.push(original)
  if (meetingBuffer.length > MEETING_BUFFER_MAX) {
    meetingBuffer.shift()
  }
  if (extractBusy || !currentKey() || !QUESTION_GATE.test(original)) {
    return
  }
  extractBusy = true
  const windowText = meetingBuffer.slice(-3).join('\n')
  try {
    const found = await extractQuestions(settings.provider, currentKey(), windowText)
    if (!tab.active) {
      return
    }
    for (const question of found) {
      pushVisibleQuestion(question)
    }
  } catch {
    // Detection is best-effort; do not surface as a live STT failure.
  } finally {
    extractBusy = false
  }
}

async function answerOverlayQuestion(id: string): Promise<void> {
  const item = visibleQuestions.find((entry) => entry.id === id)
  if (!item) {
    return
  }
  persistApiKey()
  if (!currentKey()) {
    sendOverlay({
      type: MessageType.ShowOverlayAnswer,
      id,
      error: chrome.i18n.getMessage('tabNeedsKey'),
    })
    return
  }
  try {
    const answer = await answerQuestion(
      settings.provider,
      currentKey(),
      item.text,
      meetingBuffer.join('\n'),
      uiLanguage(),
    )
    if (!answer) {
      sendOverlay({
        type: MessageType.ShowOverlayAnswer,
        id,
        error: formatAnswerIssue('empty'),
      })
      return
    }
    sendOverlay({ type: MessageType.ShowOverlayAnswer, id, answer })
  } catch (error) {
    sendOverlay({
      type: MessageType.ShowOverlayAnswer,
      id,
      error: formatAnswerIssue(classifyApiError(error), error),
    })
  }
}

function formatAnswerIssue(kind: ApiFailureKind | 'empty', error?: unknown): string {
  const suffix =
    kind === 'empty'
      ? 'Unknown'
      : kind === 'badKey'
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
  const template =
    chrome.i18n.getMessage(`issueAnswer${suffix}`) || chrome.i18n.getMessage('issueAnswerUnknown')
  return template
    .replaceAll('{provider}', providerTitle())
    .replaceAll('{detail}', error instanceof Error ? error.message : '')
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

async function requestHostPermission(): Promise<void> {
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
}

async function enableOnScreenCaptions(): Promise<void> {
  await requestHostPermission()
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

function reportSidePanel(): void {
  void chrome.storage.local.set({
    sidePanelOpen: true,
    sidePanelWidth: Math.round(window.innerWidth),
  })
}

function paintLevel(level: number, bands: number[]): void {
  frameEl.classList.add('live')
  waveEl.classList.add('live')
  frameEl.style.setProperty('--level', String(level))
  waveLive = true
  waveLevel = level
  waveBands = bands
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
  waveLive = false
  waveLevel = 0
  waveBands = []
}

function sizeWave(): void {
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(waveEl.clientWidth * dpr))
  const height = Math.max(1, Math.round(waveEl.clientHeight * dpr))
  if (width === waveWidth && height === waveHeight) {
    return
  }
  waveWidth = width
  waveHeight = height
  waveEl.width = width
  waveEl.height = height
}

function waveTarget(index: number, now: number): number {
  if (!waveLive) {
    const x = index / (WAVE_POINTS - 1)
    const a = 0.5 + 0.5 * Math.sin(now / 183 + x * 12.6)
    const b = 0.5 + 0.5 * Math.sin(now / 255 + x * 7.1)
    const c = 0.5 + 0.5 * Math.sin(now / 140 + x * 18.4)
    return 0.1 + 0.34 * a + 0.18 * b + 0.08 * c
  }
  const src = waveBands.length > 0 ? waveBands : [waveLevel]
  const pos = (index / (WAVE_POINTS - 1)) * (src.length - 1)
  const left = Math.floor(pos)
  const right = Math.min(src.length - 1, left + 1)
  const mix = (1 - Math.cos((pos - left) * Math.PI)) / 2
  const value = (src[left] ?? waveLevel) * (1 - mix) + (src[right] ?? waveLevel) * mix
  return Math.min(1, 0.08 + value * 0.92)
}

function drawWave(now: number): void {
  sizeWave()
  const ease = waveLive ? 0.32 : 0.14
  for (let i = 0; i < WAVE_POINTS; i += 1) {
    waveDisplay[i] += (waveTarget(i, now) - waveDisplay[i]) * ease
  }

  const width = waveEl.width
  const height = waveEl.height
  const mid = height * 0.5
  const amp = height * 0.42
  const dpr = window.devicePixelRatio || 1

  waveCtx.clearRect(0, 0, width, height)
  waveCtx.strokeStyle = 'rgba(74, 99, 181, 0.18)'
  waveCtx.lineWidth = dpr
  waveCtx.beginPath()
  waveCtx.moveTo(0, mid)
  waveCtx.lineTo(width, mid)
  waveCtx.stroke()

  waveCtx.beginPath()
  for (let i = 0; i < WAVE_POINTS; i += 1) {
    const x = (i / (WAVE_POINTS - 1)) * width
    const y = mid - waveDisplay[i] * amp
    if (i === 0) {
      waveCtx.moveTo(x, y)
    } else {
      waveCtx.lineTo(x, y)
    }
  }
  for (let i = WAVE_POINTS - 1; i >= 0; i -= 1) {
    const x = (i / (WAVE_POINTS - 1)) * width
    waveCtx.lineTo(x, mid + waveDisplay[i] * amp)
  }
  waveCtx.closePath()
  const fill = waveCtx.createLinearGradient(0, mid - amp, 0, mid + amp)
  fill.addColorStop(0, 'rgba(142, 160, 232, 0.5)')
  fill.addColorStop(0.5, 'rgba(74, 99, 181, 0.16)')
  fill.addColorStop(1, 'rgba(142, 160, 232, 0.5)')
  waveCtx.fillStyle = fill
  waveCtx.fill()

  waveCtx.beginPath()
  for (let i = 0; i < WAVE_POINTS; i += 1) {
    const x = (i / (WAVE_POINTS - 1)) * width
    const y = mid - waveDisplay[i] * amp
    if (i === 0) {
      waveCtx.moveTo(x, y)
    } else {
      waveCtx.lineTo(x, y)
    }
  }
  waveCtx.strokeStyle = waveLive ? 'rgba(74, 99, 181, 0.95)' : 'rgba(74, 99, 181, 0.55)'
  waveCtx.lineWidth = 1.25 * dpr
  waveCtx.lineJoin = 'round'
  waveCtx.lineCap = 'round'
  waveCtx.stroke()

  if (waveLive) {
    let peak = 0
    for (let i = 1; i < WAVE_POINTS; i += 1) {
      if (waveDisplay[i] > waveDisplay[peak]) {
        peak = i
      }
    }
    if (waveDisplay[peak] > 0.32) {
      waveCtx.beginPath()
      waveCtx.fillStyle = 'rgba(201, 146, 42, 0.92)'
      waveCtx.arc((peak / (WAVE_POINTS - 1)) * width, mid - waveDisplay[peak] * amp, 2.1 * dpr, 0, Math.PI * 2)
      waveCtx.fill()
    }
  }
}

function loopWave(now: number): void {
  drawWave(now)
  requestAnimationFrame(loopWave)
}

new ResizeObserver(() => {
  waveWidth = 0
  sizeWave()
}).observe(waveEl)
requestAnimationFrame(loopWave)
