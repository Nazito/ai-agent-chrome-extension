import { MicrophoneSession, requestMicrophone } from './mic.js'
import {
  answerQuestion,
  extractQuestions,
  isCutQuestion,
  looksRussian,
  transcribeAudio,
  translateText,
} from '../shared/llm.js'
import {
  classifyApiError,
  NamedError,
  overlayIssueKey,
  type ApiFailureKind,
} from '../shared/errors.js'
import { MessageType } from '../shared/messages.js'
import {
  loadLlmSettings,
  loadMeetingProfile,
  loadTranslateDirection,
  PRESET_BADGES,
  PROFILE_QUESTIONS,
  compileProfile,
  saveMeetingProfile,
  saveProvider,
  saveProviderKey,
  type LlmSettings,
  type MeetingProfile,
  type ProfileQuestionId,
  type ProviderId,
  type TranslateDirection,
} from '../shared/storage.js'
import { pickTabAudio, TabAudioSession } from './tab-client.js'

const statusEl = document.getElementById('status')!
const hintEl = document.getElementById('starter-body')!
const micToggle = document.getElementById('mic-toggle') as HTMLButtonElement
const tabToggle = document.getElementById('tab-toggle') as HTMLButtonElement
const captionsToggle = document.getElementById('captions-toggle') as HTMLButtonElement
const sidebarCaptionsToggle = document.getElementById(
  'sidebar-captions-toggle',
) as HTMLButtonElement
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
const profileEl = document.getElementById('profile') as HTMLTextAreaElement | null
const profileLabel = document.getElementById('profile-label')
const profileQuestionsEl = document.getElementById('profile-questions')
const profileSummaryLabel = document.getElementById('profile-summary-label')
const profileReset = document.getElementById('profile-reset') as HTMLButtonElement | null
const profileOpen = document.getElementById('profile-open') as HTMLButtonElement | null
const profilePreview = document.getElementById('profile-preview')
const profileModal = document.getElementById('profile-modal') as HTMLDialogElement | null
const profileModalTitle = document.getElementById('profile-modal-title')
const profileModalClose = document.getElementById('profile-modal-close') as HTMLButtonElement | null
const profileModalDone = document.getElementById('profile-modal-done') as HTMLButtonElement | null
const badgesLabel = document.getElementById('badges-label')!
const badgesEl = document.getElementById('badges')!
const badgeInput = document.getElementById('badge-input') as HTMLInputElement
const tagFieldEl = document.getElementById('tag-field')
const tagMenuEl = document.getElementById('tag-menu')
const tagSelectEl = document.getElementById('tag-select')

const PRESET_BADGE_MESSAGES: Record<string, string> = {
  'job-interview': 'badgeJobInterview',
  javascript: 'badgeJavascript',
  typescript: 'badgeTypescript',
  react: 'badgeReact',
  frontend: 'badgeFrontend',
  backend: 'badgeBackend',
  'system-design': 'badgeSystemDesign',
  'code-review': 'badgeCodeReview',
  'one-on-one': 'badgeOneOnOne',
  standup: 'badgeStandup',
}

const PROFILE_QUESTION_MESSAGES: Record<ProfileQuestionId, string> = {
  name: 'profileQName',
  role: 'profileQRole',
  experience: 'profileQExperience',
  stack: 'profileQStack',
  goal: 'profileQGoal',
  languages: 'profileQLanguages',
  notes: 'profileQNotes',
}

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
let meetingProfile: MeetingProfile = {
  profile: '',
  answers: {},
  profileCustom: false,
  badges: [],
  customBadges: [],
}
let profileSaveTimer = 0
let hideSidebarCaptions = true
let overlayPlaques = 0
let translateDirection: TranslateDirection = 'en-ru'
let overlayKeepAlive = 0
let lastOverlayWakeAt = 0
let tagMenuOpen = false
let tagHighlight = 0
let whisperBusy = false
let translateBusy = false
let extractBusy = false
let extractQueued = false
let hintLockUntil = 0
let silentSince = 0
let sidePanelClosing = false
let sidePanelPort: chrome.runtime.Port | null = null
let liveIssue: { status: string; hint: string } | null = null
const whisperQueue: Array<{ blob: Blob; at: number }> = []
const translateQueue: string[] = []
const meetingBuffer: string[] = []
const dismissedQuestions = new Set<string>()
const visibleQuestions: Array<{
  id: string
  text: string
  key: string
  textEn: string
  textRu: string
  answerEn: string
  answerRu: string
}> = []
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
if (profileLabel) {
  profileLabel.textContent = chrome.i18n.getMessage('profileLabel')
}
if (profileModalTitle) {
  profileModalTitle.textContent = chrome.i18n.getMessage('profileLabel')
}
if (profileSummaryLabel) {
  profileSummaryLabel.textContent = chrome.i18n.getMessage('profileSummaryLabel')
}
if (profileReset) {
  profileReset.textContent = chrome.i18n.getMessage('profileReset')
}
if (profileModalDone) {
  profileModalDone.textContent = chrome.i18n.getMessage('profileDone')
}
if (profileModalClose) {
  profileModalClose.setAttribute('aria-label', chrome.i18n.getMessage('overlayClose'))
}
if (profileEl) {
  profileEl.placeholder = chrome.i18n.getMessage('profilePlaceholder')
}
paintProfileQuestions()
paintProfilePreview()
if (badgesLabel) {
  badgesLabel.textContent = chrome.i18n.getMessage('badgesLabel')
}
if (badgeInput) {
  badgeInput.placeholder = chrome.i18n.getMessage('badgeAddPlaceholder')
}
if (badgesEl) {
  paintBadges()
}
statusEl.textContent = chrome.i18n.getMessage('statusStandby')
statusEl.title = statusEl.textContent
writeHint(chrome.i18n.getMessage('micIdleHint'))
labelButton(captionsToggle, 'captionsOpen')
labelButton(clearOriginal, 'clearOriginal')
labelButton(clearTranslation, 'clearTranslation')
setSourceState(micToggle, false)
setSourceState(tabToggle, false)

syncLayout()
syncCaptionsButton()
syncDirectionUi()
void chrome.runtime.sendMessage({ type: MessageType.RequestPlaqueCount }).catch(() => undefined)
connectSidePanelPort()
reportSidePanel()
void chrome.runtime.sendMessage({
  type: MessageType.SidePanelPresence,
  visible: document.visibilityState === 'visible',
}).catch(() => undefined)
window.addEventListener('resize', reportSidePanel)
window.addEventListener('pagehide', closeSidePanelOverlays)
window.addEventListener('beforeunload', closeSidePanelOverlays)
document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible'
  void chrome.runtime
    .sendMessage({ type: MessageType.SidePanelPresence, visible })
    .catch(() => undefined)
  if (!visible) {
    hideOverlaysFromSidePanel()
    return
  }
  sidePanelClosing = false
  reportSidePanel()
  connectSidePanelPort()
  if (tab.active) {
    startOverlayKeepAlive()
    void sendOverlay({ type: MessageType.EnableOverlay, direction: translateDirection })
  }
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

void loadMeetingProfile().then((value) => {
  meetingProfile = value
  fillProfileUi()
  paintBadges()
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

if (profileEl) {
  profileEl.addEventListener('input', () => {
    meetingProfile.profile = profileEl.value.slice(0, 4000)
    meetingProfile.profileCustom = true
    syncProfileReset()
    window.clearTimeout(profileSaveTimer)
    profileSaveTimer = window.setTimeout(() => {
      void saveMeetingProfile(meetingProfile)
      paintProfilePreview()
    }, 250)
  })
}
profileReset?.addEventListener('click', () => {
  meetingProfile.profileCustom = false
  meetingProfile.profile = compiledProfile()
  fillProfileUi()
  persistProfile()
})
profileOpen?.addEventListener('click', () => {
  openProfileModal()
})
profileModalClose?.addEventListener('click', () => {
  closeProfileModal()
})
profileModalDone?.addEventListener('click', () => {
  closeProfileModal()
})
profileModal?.addEventListener('click', (event) => {
  if (event.target === profileModal) {
    closeProfileModal()
  }
})
profileModal?.addEventListener('close', () => {
  persistProfile()
  paintProfilePreview()
})

if (badgeInput) {
  badgeInput.addEventListener('input', () => {
    tagHighlight = 0
    openTagMenu()
  })
  badgeInput.addEventListener('focus', () => {
    openTagMenu()
  })
  badgeInput.addEventListener('keydown', onTagKeydown)
}
tagFieldEl?.addEventListener('click', () => {
  badgeInput?.focus()
  openTagMenu()
})
tagMenuEl?.addEventListener('mousedown', (event) => {
  event.preventDefault()
})
document.addEventListener('mousedown', (event) => {
  if (!tagSelectEl || tagSelectEl.contains(event.target as Node)) {
    return
  }
  closeTagMenu()
})

chrome.runtime.onMessage.addListener(
  (message: {
    type?: string
    count?: number
    target?: 'original' | 'translation'
    id?: string
  }) => {
    if (message.type === MessageType.OverlayPlaqueCount && typeof message.count === 'number') {
      setOverlayPlaques(message.count)
    }
    if (message.type === MessageType.ClearOverlayCaption) {
      clearCaptionBoxes(message.target)
    }
    if (message.type === MessageType.ClearOverlayQuestions) {
      hideAllQuestionPlaques()
    }
    if (message.type === MessageType.CloseOverlayPlaque && message.target) {
      if (message.target === 'original') {
        clearCaptionBoxes('original')
      }
      if (message.target === 'translation') {
        clearCaptionBoxes('translation')
      }
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
  stopOverlayKeepAlive()
  void saveMeetingProfile(meetingProfile)
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
    startOverlayKeepAlive()
    setHint(chrome.i18n.getMessage('captionsOpened'), 8000)
  } catch (error) {
    if (tab.active) {
      reportOverlayIssue(error)
    }
  }
}

async function stopTabListening(): Promise<void> {
  clearLiveIssue()
  dropQueuedWork()
  stopOverlayKeepAlive()
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
  if (level < 0.04) {
    if (!silentSince) {
      silentSince = Date.now()
    }
    if (Date.now() - silentSince >= 700) {
      dropStaleAudio()
    }
  } else {
    silentSince = 0
  }
  if (
    !whisperBusy &&
    Date.now() >= hintLockUntil &&
    !liveIssue &&
    !statusEl.classList.contains('error')
  ) {
    writeHint(
      chrome.i18n.getMessage(
        !currentKey() ? 'tabNeedsKey' : level < 0.04 ? 'tabSilent' : 'tabLiveHint',
      ),
    )
  }
}

function onTabChunk(blob: Blob, _rms: number): void {
  persistApiKey()
  if (!currentKey()) {
    setHint(chrome.i18n.getMessage('tabNeedsKey'), 8000)
    return
  }
  silentSince = 0
  whisperQueue.push({ blob, at: Date.now() })
  if (whisperQueue.length > 3) {
    whisperQueue.shift()
  }
  void drainWhisperQueue()
}

function dropStaleAudio(): void {
  const fresh = Date.now() - 2500
  if (whisperQueue.length === 0 || whisperQueue.every((item) => item.at >= fresh)) {
    return
  }
  whisperQueue.splice(0, whisperQueue.length, ...whisperQueue.filter((item) => item.at >= fresh))
}

function dropQueuedWork(): void {
  whisperQueue.length = 0
  translateQueue.length = 0
}

async function drainWhisperQueue(): Promise<void> {
  if (whisperBusy) {
    return
  }

  whisperBusy = true
  try {
    while (whisperQueue.length > 0) {
      const item = whisperQueue.shift()
      if (!item) {
        break
      }
      try {
        setHint(
          chrome.i18n.getMessage(
            translateDirection === 'en-ru' ? 'tabTranscribingEn' : 'tabTranscribingRu',
          ),
        )
        const original = await transcribeAudio(
          settings.provider,
          currentKey(),
          item.blob,
          translateDirection,
        )
        if (!tab.active) {
          break
        }
        if (!original) {
          setHint(
            chrome.i18n.getMessage(
              translateDirection === 'en-ru' ? 'tabWaitingSpeechEn' : 'tabWaitingSpeechRu',
            ),
          )
          continue
        }
        appendCaption(originalEl, original)
        wakeOverlayIfIdle()
        void sendOverlay({
          type: MessageType.ShowOverlayCaption,
          original,
          translation: '',
        })
        void detectQuestions(original)
        enqueueTranslation(original)
      } catch (error) {
        reportLlmIssue('transcribe', classifyApiError(error), error)
      }
    }
  } finally {
    whisperBusy = false
  }
}

function enqueueTranslation(original: string): void {
  setHint(
    chrome.i18n.getMessage(
      translateDirection === 'en-ru' ? 'tabTranslatingRu' : 'tabTranslatingEn',
    ),
  )
  translateQueue.push(original)
  if (translateQueue.length > 4) {
    translateQueue.shift()
  }
  void drainTranslateQueue()
}

async function drainTranslateQueue(): Promise<void> {
  if (translateBusy) {
    return
  }
  translateBusy = true
  try {
    while (translateQueue.length > 0) {
      const original = translateQueue.shift()
      if (!original) {
        break
      }
      try {
        const translated = await translateText(
          settings.provider,
          currentKey(),
          original,
          translateDirection,
        )
        if (!tab.active) {
          break
        }
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
        if (!whisperBusy) {
          setHint(chrome.i18n.getMessage('tabLiveHint'))
        }
      } catch (error) {
        reportLlmIssue('translate', classifyApiError(error), error)
      }
    }
  } finally {
    translateBusy = false
  }
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
    | {
        type: typeof MessageType.ShowOverlayQuestion
        id: string
        question: string
        questionEn?: string
        questionRu?: string
      }
    | { type: typeof MessageType.DismissOverlayQuestion; id: string }
    | { type: typeof MessageType.RequestOverlayAnswer; id: string }
    | {
        type: typeof MessageType.ShowOverlayAnswer
        id: string
        answer?: string
        answerEn?: string
        answerRu?: string
        error?: string
      }
    | { type: typeof MessageType.ClearOverlayQuestions },
): Promise<void> {
  return Promise.race([
    chrome.runtime
      .sendMessage(message)
      .then(() => undefined)
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 800)
    }),
  ])
}

function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function questionsOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  const shorter = left.length < right.length ? left : right
  const longer = left.length < right.length ? right : left
  if (longer.includes(shorter) && shorter.length / longer.length > 0.45) {
    return true
  }
  const leftWords = shorter.split(' ').filter((word) => word.length > 1)
  const rightWords = longer.split(' ').filter((word) => word.length > 1)
  if (leftWords.length < 3 || rightWords.length < 3) {
    return false
  }
  const joined = rightWords.join(' ')
  const hit = leftWords.filter((word) => joined.includes(word)).length
  return hit / leftWords.length > 0.78
}

function isDismissedQuestion(key: string): boolean {
  for (const dismissed of dismissedQuestions) {
    if (questionsOverlap(dismissed, key)) {
      return true
    }
  }
  return false
}

function resetQuestions(): void {
  meetingBuffer.length = 0
  dismissedQuestions.clear()
  visibleQuestions.length = 0
  questionSeq = 0
}

function replayOverlayQuestions(): void {
  for (const item of visibleQuestions) {
    sendQuestion(item)
  }
}

function sendQuestion(item: (typeof visibleQuestions)[number]): void {
  void sendOverlay({
    type: MessageType.ShowOverlayQuestion,
    id: item.id,
    question: item.text,
    questionEn: item.textEn || undefined,
    questionRu: item.textRu || undefined,
  })
}

function sendAnswer(item: (typeof visibleQuestions)[number], error?: string): void {
  void sendOverlay({
    type: MessageType.ShowOverlayAnswer,
    id: item.id,
    answer: item.answerRu || item.answerEn || undefined,
    answerEn: item.answerEn || undefined,
    answerRu: item.answerRu || undefined,
    error,
  })
}

function hideOverlaysFromSidePanel(): void {
  stopOverlayKeepAlive()
  void chrome.storage.local.set({ sidePanelOpen: false })
  void sendOverlay({ type: MessageType.DisableOverlay })
}

function closeSidePanelOverlays(): void {
  if (sidePanelClosing) {
    return
  }
  sidePanelClosing = true
  hideOverlaysFromSidePanel()
  void chrome.runtime
    .sendMessage({ type: MessageType.SidePanelPresence, visible: false })
    .catch(() => undefined)
}

function connectSidePanelPort(): void {
  if (sidePanelClosing || sidePanelPort) {
    return
  }
  const port = chrome.runtime.connect({ name: 'jarvis-sidepanel' })
  sidePanelPort = port
  port.onDisconnect.addListener(() => {
    if (sidePanelPort === port) {
      sidePanelPort = null
    }
    if (sidePanelClosing || document.visibilityState === 'hidden') {
      return
    }
    connectSidePanelPort()
  })
}

function hideAllQuestionPlaques(): void {
  dismissQuestion('*')
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
  if (key.length < 12 || isDismissedQuestion(key)) {
    return
  }
  const existing = visibleQuestions.find((item) => questionsOverlap(item.key, key))
  if (existing) {
    if (key.length <= existing.key.length) {
      return
    }
    const russian = looksRussian(text)
    existing.text = text
    existing.key = key
    existing.textEn = russian ? '' : text
    existing.textRu = russian ? text : ''
    existing.answerEn = ''
    existing.answerRu = ''
    sendQuestion(existing)
    void fillQuestionTranslation(existing)
    return
  }
  const russian = looksRussian(text)
  const item = {
    id: `q-${++questionSeq}`,
    text,
    key,
    textEn: russian ? '' : text,
    textRu: russian ? text : '',
    answerEn: '',
    answerRu: '',
  }
  visibleQuestions.push(item)
  while (visibleQuestions.length > VISIBLE_QUESTIONS_MAX) {
    const dropped = visibleQuestions.shift()
    if (dropped) {
      sendOverlay({ type: MessageType.DismissOverlayQuestion, id: dropped.id })
    }
  }
  sendQuestion(item)
  void fillQuestionTranslation(item)
}

async function fillQuestionTranslation(item: (typeof visibleQuestions)[number]): Promise<void> {
  if (!currentKey()) {
    return
  }
  try {
    if (item.textRu && !item.textEn) {
      item.textEn = await translateText(settings.provider, currentKey(), item.textRu, 'ru-en')
    } else if (item.textEn && !item.textRu) {
      item.textRu = await translateText(settings.provider, currentKey(), item.textEn, 'en-ru')
    }
    if (!visibleQuestions.some((entry) => entry.id === item.id)) {
      return
    }
    sendQuestion(item)
  } catch {
    // Translation of the question is best-effort.
  }
}

function localQuestions(text: string): string[] {
  const matches = text.match(/[^.!?\n]*[?？]/gu) ?? []
  return matches
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length > 12 && !isCutQuestion(item))
}

async function detectQuestions(original: string): Promise<void> {
  meetingBuffer.push(original)
  if (meetingBuffer.length > MEETING_BUFFER_MAX) {
    meetingBuffer.shift()
  }
  for (const question of localQuestions(original)) {
    pushVisibleQuestion(question)
  }
  const windowText = meetingBuffer.slice(-8).join(' ')
  for (const question of localQuestions(windowText)) {
    pushVisibleQuestion(question)
  }
  if (!currentKey() || !QUESTION_GATE.test(windowText)) {
    return
  }
  if (extractBusy) {
    extractQueued = true
    return
  }
  extractBusy = true
  try {
    do {
      extractQueued = false
      const snapshot = meetingBuffer.slice(-8).join(' ')
      const found = await extractQuestions(settings.provider, currentKey(), snapshot)
      if (!tab.active) {
        return
      }
      for (const question of found) {
        pushVisibleQuestion(question)
      }
    } while (extractQueued && tab.active && currentKey())
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
    void sendOverlay({
      type: MessageType.ShowOverlayAnswer,
      id,
      error: chrome.i18n.getMessage('tabNeedsKey'),
    })
    return
  }
  try {
    const pair = await answerQuestion(
      settings.provider,
      currentKey(),
      item.text,
      meetingBuffer.join('\n'),
      {
        profile: speakerProfile(),
        badges: meetingProfile.badges,
      },
    )
    item.answerEn = pair.en
    item.answerRu = pair.ru
    if (!item.answerEn && !item.answerRu) {
      sendAnswer(item, formatAnswerIssue('empty'))
      return
    }
    sendAnswer(item)
    if (item.answerRu && !item.answerEn) {
      item.answerEn = await translateText(settings.provider, currentKey(), item.answerRu, 'ru-en')
    } else if (item.answerEn && !item.answerRu) {
      item.answerRu = await translateText(settings.provider, currentKey(), item.answerEn, 'en-ru')
    }
    if (!visibleQuestions.some((entry) => entry.id === item.id)) {
      return
    }
    if (item.answerEn || item.answerRu) {
      sendAnswer(item)
    }
  } catch (error) {
    sendAnswer(item, formatAnswerIssue(classifyApiError(error), error))
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
  const allowed = await chrome.permissions
    .contains({ origins: ['<all_urls>'] })
    .catch(() => false)
  if (!allowed) {
    throw new NamedError('overlay-denied', chrome.i18n.getMessage('issueOverlayDenied'))
  }
}

async function enableOnScreenCaptions(): Promise<void> {
  await requestHostPermission()
  await openCaptionWindow()
  if (tab.active) {
    startOverlayKeepAlive()
  }
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

function wakeOverlayIfIdle(): void {
  if (Date.now() - lastOverlayWakeAt < 8000) {
    lastOverlayWakeAt = Date.now()
    return
  }
  lastOverlayWakeAt = Date.now()
  void sendOverlay({ type: MessageType.EnableOverlay, direction: translateDirection })
}

function startOverlayKeepAlive(): void {
  stopOverlayKeepAlive()
  overlayKeepAlive = window.setInterval(() => {
    if (!tab.active) {
      stopOverlayKeepAlive()
      return
    }
    lastOverlayWakeAt = Date.now()
    void sendOverlay({ type: MessageType.EnableOverlay, direction: translateDirection })
  }, 8000)
}

function stopOverlayKeepAlive(): void {
  window.clearInterval(overlayKeepAlive)
  overlayKeepAlive = 0
}

function syncLayout(): void {
  document.body.classList.toggle('hide-captions', hideSidebarCaptions)
  sidebarCaptionsToggle.classList.toggle('active', !hideSidebarCaptions)
  sidebarCaptionsToggle.setAttribute('aria-pressed', String(!hideSidebarCaptions))
  labelButton(
    sidebarCaptionsToggle,
    hideSidebarCaptions ? 'sidebarCaptionsShow' : 'sidebarCaptionsHide',
  )
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
  return settings.provider === 'openai'
    ? 'OpenAI'
    : settings.provider === 'groq'
      ? 'Groq'
      : 'Gemini'
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

function reportLlmIssue(
  stage: 'transcribe' | 'translate',
  kind: ApiFailureKind | 'empty',
  error?: unknown,
): void {
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

function profileQuestionLabel(id: ProfileQuestionId): string {
  return chrome.i18n.getMessage(PROFILE_QUESTION_MESSAGES[id]) || id
}

function compiledProfile(): string {
  return compileProfile(meetingProfile.answers, profileQuestionLabel)
}

function speakerProfile(): string {
  return meetingProfile.profile.trim() || compiledProfile()
}

function profilePreviewText(): string {
  const parts = [meetingProfile.answers.name, meetingProfile.answers.role, meetingProfile.answers.stack]
    .map((item) => item?.trim())
    .filter(Boolean)
  if (parts.length > 0) {
    return parts.join(' · ')
  }
  const profile = speakerProfile().split('\n')[0]?.trim() ?? ''
  return profile
}

function paintProfilePreview(): void {
  if (!profilePreview) {
    return
  }
  const text = profilePreviewText()
  profilePreview.textContent = text || chrome.i18n.getMessage('profileEmpty')
  profilePreview.classList.toggle('filled', Boolean(text))
  profileOpen?.setAttribute('aria-label', chrome.i18n.getMessage(text ? 'profileLabel' : 'profileEmpty'))
}

function openProfileModal(): void {
  fillProfileUi()
  if (profileModal && typeof profileModal.showModal === 'function' && !profileModal.open) {
    profileModal.showModal()
  }
  const firstEmpty = profileQuestionsEl?.querySelector(
    'input:not([value]), input[value=""]',
  ) as HTMLInputElement | null
  const focusEl = firstEmpty && !firstEmpty.value ? firstEmpty : profileQuestionsEl?.querySelector('input')
  ;(focusEl as HTMLInputElement | null)?.focus()
}

function closeProfileModal(): void {
  if (profileModal?.open) {
    profileModal.close()
  }
  persistProfile()
  paintProfilePreview()
}

function syncProfileReset(): void {
  if (!profileReset) {
    return
  }
  profileReset.hidden = !meetingProfile.profileCustom
}

function fillProfileUi(): void {
  if (profileEl) {
    profileEl.value = meetingProfile.profile
  }
  if (!profileQuestionsEl) {
    syncProfileReset()
    paintProfilePreview()
    return
  }
  for (const id of PROFILE_QUESTIONS) {
    const input = profileQuestionsEl.querySelector(`[data-profile-q="${id}"]`) as HTMLInputElement | null
    if (input) {
      input.value = meetingProfile.answers[id] ?? ''
    }
  }
  syncProfileReset()
  paintProfilePreview()
}

function onProfileAnswer(id: ProfileQuestionId, value: string): void {
  const text = value.replace(/\s+/g, ' ').trim().slice(0, 280)
  if (text) {
    meetingProfile.answers[id] = text
  } else {
    delete meetingProfile.answers[id]
  }
  if (!meetingProfile.profileCustom) {
    meetingProfile.profile = compiledProfile()
    if (profileEl) {
      profileEl.value = meetingProfile.profile
    }
  }
  persistProfile()
  paintProfilePreview()
}

function paintProfileQuestions(): void {
  if (!profileQuestionsEl) {
    return
  }
  profileQuestionsEl.replaceChildren()
  for (const id of PROFILE_QUESTIONS) {
    const row = document.createElement('label')
    row.className = 'profile-q'
    const title = document.createElement('span')
    title.textContent = profileQuestionLabel(id)
    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = 280
    input.autocomplete = 'off'
    input.dataset.profileQ = id
    input.value = meetingProfile.answers[id] ?? ''
    input.addEventListener('input', () => onProfileAnswer(id, input.value))
    row.append(title, input)
    profileQuestionsEl.append(row)
  }
}

function badgeLabel(id: string): string {
  const key = PRESET_BADGE_MESSAGES[id]
  return (key && chrome.i18n.getMessage(key)) || id.replace(/-/g, ' ')
}

function isBadgeOn(id: string): boolean {
  return meetingProfile.badges.some((badge) => badge.toLowerCase() === id.toLowerCase())
}

function persistProfile(): void {
  void saveMeetingProfile(meetingProfile)
}

function tagQuery(): string {
  return badgeInput?.value.replace(/\s+/g, ' ').trim() ?? ''
}

function catalogTags(): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const id of [...PRESET_BADGES, ...meetingProfile.customBadges]) {
    const key = id.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    list.push(id)
  }
  return list
}

function tagChoices(): Array<{ id: string; create: boolean }> {
  const query = tagQuery().toLowerCase()
  const available = catalogTags().filter((id) => !isBadgeOn(id))
  const filtered = query
    ? available.filter((id) => badgeLabel(id).toLowerCase().includes(query) || id.toLowerCase().includes(query))
    : available
  const choices = filtered.map((id) => ({ id, create: false }))
  if (query && !catalogTags().some((id) => badgeLabel(id).toLowerCase() === query || id.toLowerCase() === query)) {
    choices.push({ id: tagQuery().slice(0, 40), create: true })
  }
  return choices
}

function openTagMenu(): void {
  tagMenuOpen = true
  paintTagMenu()
}

function closeTagMenu(): void {
  tagMenuOpen = false
  tagHighlight = 0
  if (tagMenuEl) {
    tagMenuEl.hidden = true
  }
}

function onTagKeydown(event: KeyboardEvent): void {
  const choices = tagChoices()
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    openTagMenu()
    tagHighlight = choices.length === 0 ? 0 : (tagHighlight + 1) % choices.length
    paintTagMenu()
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    openTagMenu()
    tagHighlight = choices.length === 0 ? 0 : (tagHighlight - 1 + choices.length) % choices.length
    paintTagMenu()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeTagMenu()
    badgeInput.blur()
    return
  }
  if (event.key === 'Backspace' && !badgeInput.value && meetingProfile.badges.length > 0) {
    event.preventDefault()
    removeBadge(meetingProfile.badges[meetingProfile.badges.length - 1])
    return
  }
  if (event.key !== 'Enter') {
    return
  }
  event.preventDefault()
  const current = choices[tagHighlight]
  if (current) {
    addCustomBadge(current.id)
  } else {
    addCustomBadge(badgeInput.value)
  }
}

function addCustomBadge(raw: string): void {
  const badge = raw.replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!badge) {
    return
  }
  const preset = PRESET_BADGES.find(
    (id) => badgeLabel(id).toLowerCase() === badge.toLowerCase() || id.toLowerCase() === badge.toLowerCase(),
  )
  const id = preset ?? badge
  if (!preset && !meetingProfile.customBadges.some((item) => item.toLowerCase() === id.toLowerCase())) {
    meetingProfile.customBadges = [...meetingProfile.customBadges, id]
  }
  if (!isBadgeOn(id) && meetingProfile.badges.length < 16) {
    meetingProfile.badges = [...meetingProfile.badges, id]
  }
  if (badgeInput) {
    badgeInput.value = ''
  }
  tagHighlight = 0
  persistProfile()
  paintBadges()
  openTagMenu()
}

function removeBadge(id: string): void {
  meetingProfile.badges = meetingProfile.badges.filter((badge) => badge.toLowerCase() !== id.toLowerCase())
  persistProfile()
  paintBadges()
  if (tagMenuOpen) {
    paintTagMenu()
  }
}

function paintBadges(): void {
  if (!badgesEl) {
    return
  }
  badgesEl.replaceChildren()
  for (const id of meetingProfile.badges) {
    badgesEl.append(makeTagChip(id))
  }
  if (tagMenuOpen) {
    paintTagMenu()
  }
}

function makeTagChip(id: string): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.className = 'tag-chip'
  const label = document.createElement('span')
  label.textContent = badgeLabel(id)
  const drop = document.createElement('button')
  drop.type = 'button'
  drop.className = 'drop'
  drop.textContent = '×'
  drop.setAttribute('aria-label', chrome.i18n.getMessage('overlayClose'))
  drop.addEventListener('click', (event) => {
    event.stopPropagation()
    removeBadge(id)
  })
  chip.append(label, drop)
  return chip
}

function paintTagMenu(): void {
  if (!tagMenuEl) {
    return
  }
  const choices = tagChoices()
  tagMenuEl.replaceChildren()
  if (choices.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'tag-empty'
    empty.textContent = chrome.i18n.getMessage('badgeEmpty')
    tagMenuEl.append(empty)
  } else {
    if (tagHighlight >= choices.length) {
      tagHighlight = 0
    }
    choices.forEach((choice, index) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = `tag-option${choice.create ? ' create' : ''}${index === tagHighlight ? ' active' : ''}`
      option.textContent = choice.create
        ? chrome.i18n.getMessage('badgeCreate', [choice.id]) || `Add “${choice.id}”`
        : badgeLabel(choice.id)
      option.addEventListener('click', () => {
        addCustomBadge(choice.id)
        badgeInput?.focus()
      })
      tagMenuEl.append(option)
    })
  }
  tagMenuEl.hidden = !tagMenuOpen
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
      waveCtx.arc(
        (peak / (WAVE_POINTS - 1)) * width,
        mid - waveDisplay[peak] * amp,
        2.1 * dpr,
        0,
        Math.PI * 2,
      )
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
