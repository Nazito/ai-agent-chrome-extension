type HudHandle = { teardown: () => void; enable: () => void; hide: () => void }
type PlaqueKind = 'original' | 'translation'

void (function bootJarvisOverlay(): void {
if (window !== window.top) {
  return
}
if (!chrome?.i18n || typeof chrome.i18n.getMessage !== 'function') {
  return
}
const overlayWindow = window as Window & { __jarvisHud?: HudHandle; __jarvisHudRev?: number }
const HUD_REV = 30
const STYLE_ID = 'jarvis-hud-style'
const HOST_IDS = {
  original: 'jarvis-plaque-original',
  translation: 'jarvis-plaque-translation',
  questions: 'jarvis-plaque-questions',
  scan: 'jarvis-plaque-scan',
} as const
const PLAQUE_MIN_W = 220
const PLAQUE_MIN_H = 128
const SCAN_MIN_W = 160
const SCAN_MIN_H = 120
let sidePanelOpen = false
let sidePanelWidth = 360
const plaqueSizes: Record<string, { w: number; h: number; x?: number; y?: number }> = {}
let plaqueSaveTimer = 0

void chrome.storage.local.get({ sidePanelOpen: false, sidePanelWidth: 360, plaqueSizes: {} }).then((stored) => {
  sidePanelOpen = stored.sidePanelOpen === true
  sidePanelWidth = Number(stored.sidePanelWidth) || 360
  Object.assign(plaqueSizes, stored.plaqueSizes ?? {})
  clampMountedPlaques()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') {
    return
  }
  if (changes.sidePanelOpen) {
    sidePanelOpen = changes.sidePanelOpen.newValue === true
    if (!sidePanelOpen) {
      overlayWindow.__jarvisHud?.hide()
    }
  }
  if (changes.sidePanelWidth) {
    sidePanelWidth = Number(changes.sidePanelWidth.newValue) || 360
  }
  clampMountedPlaques()
})

if (overlayWindow.__jarvisHudRev !== HUD_REV || !overlayWindow.__jarvisHud) {
  overlayWindow.__jarvisHud?.teardown()
  overlayWindow.__jarvisHud = startOverlay()
  overlayWindow.__jarvisHudRev = HUD_REV
}

function startOverlay(): HudHandle {
  const originals: string[] = []
  const translations: string[] = []
  let lastOriginal = ''
  let visible = false
  let direction: 'en-ru' | 'ru-en' = 'en-ru'
  let closedOriginal = false
  let closedTranslation = false
  let closedQuestions = false
  let meter = 0
  let lastStatus = ''

  sweepOldHosts()
  document.getElementById(STYLE_ID)?.remove()

  const pageStyle = document.createElement('style')
  pageStyle.id = STYLE_ID
  pageStyle.textContent = `
    #${HOST_IDS.original},
    #${HOST_IDS.translation},
    #${HOST_IDS.questions},
    #${HOST_IDS.scan} {
      all: initial;
      position: fixed !important;
      z-index: 2147483647 !important;
      width: min(420px, calc(100vw - var(--jarvis-right, 16px) - 40px)) !important;
      height: 188px !important;
      margin: 0 !important;
      padding: 0 !important;
      display: none !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
      pointer-events: auto !important;
      border: 1px solid rgba(74, 99, 181, 0.22) !important;
      border-radius: 16px !important;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.28), rgba(232, 236, 250, 0.1)) !important;
      backdrop-filter: blur(16px) saturate(1.25) !important;
      -webkit-backdrop-filter: blur(16px) saturate(1.25) !important;
      box-shadow: 0 10px 28px rgba(18, 48, 58, 0.12) !important;
    }
    #${HOST_IDS.original} {
      left: 16px !important;
      bottom: 16px !important;
      top: auto !important;
      right: auto !important;
    }
    #${HOST_IDS.translation} {
      right: var(--jarvis-right, 16px) !important;
      bottom: 16px !important;
      top: auto !important;
      left: auto !important;
    }
    #${HOST_IDS.questions} {
      left: 50% !important;
      top: 16px !important;
      right: auto !important;
      bottom: auto !important;
      width: min(520px, calc(100vw - var(--jarvis-right, 16px) - 32px)) !important;
      height: 280px !important;
      transform: translateX(-50%) !important;
    }
    #${HOST_IDS.original}[data-open="1"],
    #${HOST_IDS.translation}[data-open="1"],
    #${HOST_IDS.questions}[data-open="1"] {
      display: block !important;
    }
    #${HOST_IDS.scan} {
      left: 14% !important;
      top: 16% !important;
      right: auto !important;
      bottom: auto !important;
      width: min(720px, calc(100vw - var(--jarvis-right, 16px) - 80px)) !important;
      height: min(480px, calc(100vh - 120px)) !important;
      z-index: 2147483646 !important;
      background: transparent !important;
      border: 2px solid rgba(62, 220, 232, 0.9) !important;
      border-radius: 12px !important;
      box-shadow: 0 0 0 9999px rgba(18, 48, 58, 0.4) !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      overflow: visible !important;
    }
    #${HOST_IDS.scan}[data-open="1"] {
      display: block !important;
    }
    #${HOST_IDS.scan}[data-busy="1"] {
      left: 50% !important;
      top: 22% !important;
      width: 64px !important;
      height: 64px !important;
      transform: translateX(-50%) !important;
      border: 0 !important;
      border-radius: 16px !important;
      background: rgba(255, 255, 255, 0.92) !important;
      box-shadow: 0 10px 28px rgba(18, 48, 58, 0.16) !important;
      overflow: hidden !important;
    }
    @media (max-width: 900px) {
      #${HOST_IDS.original},
      #${HOST_IDS.translation},
      #${HOST_IDS.questions} {
        width: min(720px, calc(100vw - 32px)) !important;
      }
      #${HOST_IDS.original} {
        left: 50% !important;
        bottom: 28% !important;
        transform: translateX(-50%) !important;
      }
      #${HOST_IDS.translation} {
        left: 50% !important;
        right: auto !important;
        bottom: 8% !important;
        transform: translateX(-50%) !important;
      }
      #${HOST_IDS.questions} {
        top: 12px !important;
      }
    }
  `

  const originalPlaque = createPlaque({
    id: HOST_IDS.original,
    kind: 'original',
    title: chrome.i18n.getMessage('originalLabel') || 'English',
    onClose() {
      closedOriginal = true
      render()
      reportStatus()
      void chrome.runtime
        .sendMessage({ type: 'CLOSE_OVERLAY_PLAQUE', target: 'original' })
        .catch(() => undefined)
    },
    onClear() {
      void chrome.runtime
        .sendMessage({ type: 'CLEAR_OVERLAY_CAPTION', target: 'original' })
        .catch(() => undefined)
    },
  })
  const translationPlaque = createPlaque({
    id: HOST_IDS.translation,
    kind: 'translation',
    title: chrome.i18n.getMessage('translationLabel') || 'Русский',
    onClose() {
      closedTranslation = true
      render()
      reportStatus()
      void chrome.runtime
        .sendMessage({ type: 'CLOSE_OVERLAY_PLAQUE', target: 'translation' })
        .catch(() => undefined)
    },
    onClear() {
      void chrome.runtime
        .sendMessage({ type: 'CLEAR_OVERLAY_CAPTION', target: 'translation' })
        .catch(() => undefined)
    },
  })
  const questionsPlaque = createQuestionsPlaque({
    id: HOST_IDS.questions,
    title: chrome.i18n.getMessage('overlayQuestions') || 'Questions',
    onCloseAll() {
      closedQuestions = true
      questionsPlaque.clear()
      render()
      void chrome.runtime.sendMessage({ type: 'CLEAR_OVERLAY_QUESTIONS' }).catch(() => undefined)
    },
    onDismiss(id) {
      void chrome.runtime.sendMessage({ type: 'DISMISS_OVERLAY_QUESTION', id }).catch(() => undefined)
      render()
    },
    onAsk(id) {
      void chrome.runtime.sendMessage({ type: 'REQUEST_OVERLAY_ANSWER', id }).catch(() => undefined)
    },
  })
  const scanPlaque = createScanPlaque({
    id: HOST_IDS.scan,
    title: chrome.i18n.getMessage('screenRegion') || 'Scan area',
    analyzeLabel: chrome.i18n.getMessage('screenRegionAnalyze') || 'Analyze',
    onAnalyze() {
      captureScanRegion()
    },
    onClose() {
      scanPlaque.setOpen(false)
      void chrome.runtime.sendMessage({ type: 'SCAN_REGION_CANCEL' }).catch(() => undefined)
    },
  })

  function captureScanRegion(): void {
    const rect = scanPlaque.rect()
    if (!rect) {
      return
    }
    scanPlaque.setOpen(false)
    void chrome.runtime
      .sendMessage({
        type: 'SCAN_REGION_CAPTURE',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        vw: window.innerWidth,
        vh: window.innerHeight,
      })
      .catch(() => undefined)
  }

  function applyDirection(next?: string): void {
    if (next === 'en-ru' || next === 'ru-en') {
      direction = next
    }
    originalPlaque.setTitle(
      chrome.i18n.getMessage(direction === 'en-ru' ? 'originalLabel' : 'translationLabel') ||
        (direction === 'en-ru' ? 'English' : 'Русский'),
    )
    translationPlaque.setTitle(
      chrome.i18n.getMessage(direction === 'en-ru' ? 'translationLabel' : 'originalLabel') ||
        (direction === 'en-ru' ? 'Русский' : 'English'),
    )
  }

  function sourceHint(): string {
    return (
      chrome.i18n.getMessage(direction === 'en-ru' ? 'overlayWaitingEn' : 'overlayWaitingRu') ||
      chrome.i18n.getMessage('overlayWaiting') ||
      'Waiting'
    )
  }

  function targetHint(): string {
    return (
      chrome.i18n.getMessage(direction === 'en-ru' ? 'overlayListeningRu' : 'overlayListeningEn') ||
      chrome.i18n.getMessage('overlayListening') ||
      'Listening'
    )
  }
  function mount(): void {
    if (!pageStyle.isConnected) {
      (document.head ?? document.documentElement).append(pageStyle)
    }
    const root = document.fullscreenElement ?? document.documentElement
    originalPlaque.mount(root)
    translationPlaque.mount(root)
    questionsPlaque.mount(root)
    scanPlaque.mount(root)
  }

  function hideHud(): void {
    visible = false
    originals.length = 0
    translations.length = 0
    lastOriginal = ''
    closedOriginal = true
    closedTranslation = true
    closedQuestions = true
    originalPlaque.clear()
    translationPlaque.clear()
    questionsPlaque.clear()
    if (scanPlaque.isOpen()) {
      void chrome.runtime.sendMessage({ type: 'SCAN_REGION_CANCEL' }).catch(() => undefined)
    }
    scanPlaque.setBusy(false)
    scanPlaque.setOpen(false)
    render()
  }

  function onMessage(message: {
    type?: string
    original?: string
    translation?: string
    direction?: 'en-ru' | 'ru-en'
    target?: 'original' | 'translation'
    id?: string
    question?: string
    questionEn?: string
    questionRu?: string
    answer?: string
    answerEn?: string
    answerRu?: string
    code?: string
    error?: string
  }): void {
    if (message.type === 'ENABLE_OVERLAY') {
      closedOriginal = false
      closedTranslation = false
      visible = true
      applyDirection(message.direction)
      render()
      return
    }
    if (message.type === 'SET_TRANSLATE_DIRECTION') {
      applyDirection(message.direction)
      render()
      return
    }
    if (message.type === 'SHOW_OVERLAY_CAPTION') {
      if (!sidePanelOpen && !visible) {
        return
      }
      if (closedOriginal && closedTranslation) {
        return
      }
      visible = true
      pushCaption(message.original ?? '', message.translation ?? '')
      return
    }
    if (message.type === 'CLEAR_OVERLAY_CAPTION') {
      if (message.target !== 'translation') {
        originals.length = 0
        lastOriginal = ''
        originalPlaque.clear()
      }
      if (message.target !== 'original') {
        translations.length = 0
        translationPlaque.clear()
      }
      render()
      return
    }
    if (message.type === 'CLOSE_OVERLAY_PLAQUE') {
      if (message.target === 'original') {
        closedOriginal = true
      }
      if (message.target === 'translation') {
        closedTranslation = true
      }
      render()
      reportStatus()
      return
    }
    if (message.type === 'SHOW_OVERLAY_QUESTION' && message.id && message.question) {
      if (!sidePanelOpen && !visible) {
        return
      }
      closedQuestions = false
      questionsPlaque.upsert(message.id, {
        question: message.question,
        questionEn: message.questionEn,
        questionRu: message.questionRu,
      })
      if (message.answer || message.answerEn || message.answerRu || message.code || message.error) {
        questionsPlaque.setAnswer(message.id, {
          answer: message.answer,
          answerEn: message.answerEn,
          answerRu: message.answerRu,
          code: message.code,
          error: message.error,
        })
      }
      render()
      return
    }
    if (message.type === 'DISMISS_OVERLAY_QUESTION' && message.id) {
      questionsPlaque.drop(message.id)
      render()
      return
    }
    if (message.type === 'SHOW_OVERLAY_ANSWER' && message.id) {
      if (!sidePanelOpen && !visible) {
        return
      }
      questionsPlaque.setAnswer(message.id, {
        answer: message.answer,
        answerEn: message.answerEn,
        answerRu: message.answerRu,
        code: message.code,
        error: message.error,
      })
      render()
      return
    }
    if (message.type === 'CLEAR_OVERLAY_QUESTIONS') {
      questionsPlaque.clear()
      closedQuestions = true
      render()
      return
    }
    if (message.type === 'SHOW_SCAN_REGION') {
      mount()
      scanPlaque.setBusy(false)
      scanPlaque.setOpen(true)
      return
    }
    if (message.type === 'HIDE_SCAN_REGION') {
      scanPlaque.setBusy(false)
      scanPlaque.setOpen(false)
      return
    }
    if (message.type === 'SHOW_SCAN_SPINNER') {
      mount()
      scanPlaque.setBusy(true)
      return
    }
    if (message.type === 'REQUEST_SCAN_CAPTURE') {
      captureScanRegion()
      return
    }
    if (message.type === 'DISABLE_OVERLAY') {
      hideHud()
    }
  }

  const onRuntimeMessage = (
    message: Parameters<typeof onMessage>[0],
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { ok: true }) => void,
  ) => {
    onMessage(message)
    sendResponse({ ok: true })
    return false
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage)
  document.addEventListener('fullscreenchange', mount)
  meter = window.setInterval(mount, 800)

  function pushCaption(original: string, translation: string): void {
    if (original && original !== lastOriginal) {
      lastOriginal = original
      originals.push(original)
      originalPlaque.append(original)
    }
    if (translation) {
      const last = translations[translations.length - 1]
      if (last !== translation) {
        translations.push(translation)
        translationPlaque.append(translation)
      }
    }
    render()
  }

  function render(): void {
    mount()
    originalPlaque.setOpen(visible && !closedOriginal)
    translationPlaque.setOpen(visible && !closedTranslation)
    questionsPlaque.setOpen(visible && !closedQuestions && questionsPlaque.ids().length > 0)
    if (originals.length === 0) {
      originalPlaque.showHint(sourceHint())
    }
    if (translations.length === 0) {
      translationPlaque.showHint(targetHint())
    }
    reportStatus()
  }

  function reportStatus(): void {
    const original = visible && !closedOriginal
    const translation = visible && !closedTranslation
    const key = `${original}:${translation}`
    if (key === lastStatus) {
      return
    }
    lastStatus = key
    void chrome.runtime
      .sendMessage({
        type: 'OVERLAY_STATUS',
        original,
        translation,
      })
      .catch(() => undefined)
  }

  mount()
  render()

  return {
    enable() {
      closedOriginal = false
      closedTranslation = false
      visible = true
      render()
    },
    hide() {
      hideHud()
    },
    teardown() {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage)
      document.removeEventListener('fullscreenchange', mount)
      window.clearInterval(meter)
      originalPlaque.remove()
      translationPlaque.remove()
      questionsPlaque.unmount()
      scanPlaque.unmount()
      pageStyle.remove()
    },
  }
}

function plaquePads(): { left: number; right: number; top: number; bottom: number } {
  const gap = Math.max(0, window.outerWidth - window.innerWidth)
  const overlaying = sidePanelOpen && sidePanelWidth > 200 && gap < sidePanelWidth * 0.5
  const right = overlaying ? Math.min(sidePanelWidth + 12, Math.max(200, window.innerWidth * 0.4)) : 16
  return { left: 16, right, top: 16, bottom: 16 }
}

function clampMountedPlaques(): void {
  const pads = plaquePads()
  const value = `${Math.round(pads.right)}px`
  for (const id of Object.values(HOST_IDS)) {
    const host = document.getElementById(id)
    if (!host) {
      continue
    }
    host.style.setProperty('--jarvis-right', value)
    if (host.getAttribute('data-open') === '1' || host.style.display === 'block') {
      clampPlaque(host)
    }
  }
}

function plaqueLimits(host: HTMLElement): { minW: number; minH: number } {
  if (host.id === HOST_IDS.scan) {
    return { minW: SCAN_MIN_W, minH: SCAN_MIN_H }
  }
  return { minW: PLAQUE_MIN_W, minH: PLAQUE_MIN_H }
}

function clampPlaque(host: HTMLElement): void {
  if (host.getAttribute('data-busy') === '1') {
    return
  }
  if (host.offsetWidth < 8) {
    if (host.id === HOST_IDS.scan) {
      placeScanIfLost(host)
    }
    return
  }
  const pads = plaquePads()
  const mins = plaqueLimits(host)
  const maxW = Math.max(mins.minW, window.innerWidth - pads.left - pads.right)
  const maxH = Math.max(mins.minH, window.innerHeight - pads.top - pads.bottom)
  const rect = host.getBoundingClientRect()
  const width = Math.min(Math.max(mins.minW, rect.width), maxW)
  const height = Math.min(Math.max(mins.minH, rect.height), maxH)
  const left = Math.min(Math.max(pads.left, rect.left), window.innerWidth - pads.right - width)
  const top = Math.min(Math.max(pads.top, rect.top), window.innerHeight - pads.bottom - height)
  setImportantPx(host, 'width', width)
  setImportantPx(host, 'height', height)
  setImportantPx(host, 'left', left)
  setImportantPx(host, 'top', top)
  host.style.setProperty('right', 'auto', 'important')
  host.style.setProperty('bottom', 'auto', 'important')
  host.style.setProperty('transform', 'none', 'important')
}

function placeScanIfLost(host: HTMLElement): void {
  if (host.id !== HOST_IDS.scan || host.getAttribute('data-busy') === '1') {
    return
  }
  const rect = host.getBoundingClientRect()
  const onScreen =
    rect.width >= SCAN_MIN_W &&
    rect.height >= SCAN_MIN_H &&
    rect.bottom > 48 &&
    rect.right > 48 &&
    rect.top < window.innerHeight - 48 &&
    rect.left < window.innerWidth - 48
  if (onScreen) {
    return
  }
  const pads = plaquePads()
  const maxW = Math.max(SCAN_MIN_W, window.innerWidth - pads.left - pads.right)
  const maxH = Math.max(SCAN_MIN_H, window.innerHeight - pads.top - pads.bottom)
  const width = Math.min(720, maxW)
  const height = Math.min(480, maxH)
  setImportantPx(host, 'width', width)
  setImportantPx(host, 'height', height)
  setImportantPx(host, 'left', pads.left + Math.max(0, (maxW - width) / 2))
  setImportantPx(host, 'top', pads.top + 24)
  host.style.setProperty('right', 'auto', 'important')
  host.style.setProperty('bottom', 'auto', 'important')
  host.style.setProperty('transform', 'none', 'important')
}

function setImportantPx(host: HTMLElement, prop: string, value: number): void {
  const next = `${Math.round(value)}px`
  if (host.style.getPropertyValue(prop) === next) {
    return
  }
  host.style.setProperty(prop, next, 'important')
}

function applySavedSize(host: HTMLElement): void {
  const saved = plaqueSizes[host.id]
  if (!saved) {
    return
  }
  setImportantPx(host, 'width', saved.w)
  setImportantPx(host, 'height', saved.h)
  if (saved.x !== undefined && saved.y !== undefined) {
    setImportantPx(host, 'left', saved.x)
    setImportantPx(host, 'top', saved.y)
    host.style.setProperty('right', 'auto', 'important')
    host.style.setProperty('bottom', 'auto', 'important')
    host.style.setProperty('transform', 'none', 'important')
  }
}

function persistPlaqueSize(host: HTMLElement): void {
  const rect = host.getBoundingClientRect()
  plaqueSizes[host.id] = {
    w: host.offsetWidth,
    h: host.offsetHeight,
    ...(host.id === HOST_IDS.scan ? { x: rect.left, y: rect.top } : {}),
  }
  window.clearTimeout(plaqueSaveTimer)
  plaqueSaveTimer = window.setTimeout(() => {
    void chrome.storage.local.set({ plaqueSizes })
  }, 180)
}

function bindPlaqueFrame(host: HTMLElement, handle: HTMLElement, grip: HTMLElement, ignore: HTMLElement[]): () => void {
  let dragging = false
  let resizing = false
  let offsetX = 0
  let offsetY = 0
  let startX = 0
  let startY = 0
  let startLeft = 0
  let startTop = 0
  let startWidth = 0
  let startHeight = 0

  const onHandleDown = (event: PointerEvent) => {
    const target = event.target as Node
    if (ignore.some((node) => node === target || node.contains(target))) {
      return
    }
    dragging = true
    const rect = host.getBoundingClientRect()
    offsetX = event.clientX - rect.left
    offsetY = event.clientY - rect.top
    clampPlaque(host)
    handle.setPointerCapture(event.pointerId)
  }

  const onHandleMove = (event: PointerEvent) => {
    if (!dragging) {
      return
    }
    const pads = plaquePads()
    const width = host.offsetWidth
    const height = host.offsetHeight
    const left = Math.min(
      Math.max(pads.left, event.clientX - offsetX),
      window.innerWidth - pads.right - width,
    )
    const top = Math.min(
      Math.max(pads.top, event.clientY - offsetY),
      window.innerHeight - pads.bottom - height,
    )
    setImportantPx(host, 'left', left)
    setImportantPx(host, 'top', top)
  }

  const stopDrag = () => {
    if (dragging) {
      persistPlaqueSize(host)
    }
    dragging = false
  }

  const onGripDown = (event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    resizing = true
    clampPlaque(host)
    const rect = host.getBoundingClientRect()
    startX = event.clientX
    startY = event.clientY
    startLeft = rect.left
    startTop = rect.top
    startWidth = rect.width
    startHeight = rect.height
    grip.setPointerCapture(event.pointerId)
  }

  const onGripMove = (event: PointerEvent) => {
    if (!resizing) {
      return
    }
    const pads = plaquePads()
    const mins = plaqueLimits(host)
    const maxW = Math.max(mins.minW, window.innerWidth - pads.left - pads.right)
    const maxH = Math.max(mins.minH, window.innerHeight - pads.top - pads.bottom)
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    let width = Math.min(Math.max(mins.minW, startWidth + dx), maxW)
    let height = Math.min(Math.max(mins.minH, startHeight + dy), maxH)
    let left = startLeft
    let top = startTop
    const maxRight = window.innerWidth - pads.right
    const maxBottom = window.innerHeight - pads.bottom
    if (left + width > maxRight) {
      left = maxRight - width
    }
    if (left < pads.left) {
      left = pads.left
      width = Math.min(width, maxRight - left)
    }
    if (top + height > maxBottom) {
      top = maxBottom - height
    }
    if (top < pads.top) {
      top = pads.top
      height = Math.min(height, maxBottom - top)
    }
    setImportantPx(host, 'width', width)
    setImportantPx(host, 'height', height)
    setImportantPx(host, 'left', left)
    setImportantPx(host, 'top', top)
    host.style.setProperty('right', 'auto', 'important')
    host.style.setProperty('bottom', 'auto', 'important')
    persistPlaqueSize(host)
  }

  const stopResize = () => {
    if (resizing) {
      persistPlaqueSize(host)
    }
    resizing = false
  }

  const onViewport = () => clampPlaque(host)

  handle.addEventListener('pointerdown', onHandleDown)
  handle.addEventListener('pointermove', onHandleMove)
  handle.addEventListener('pointerup', stopDrag)
  handle.addEventListener('pointercancel', stopDrag)
  grip.addEventListener('pointerdown', onGripDown)
  grip.addEventListener('pointermove', onGripMove)
  grip.addEventListener('pointerup', stopResize)
  grip.addEventListener('pointercancel', stopResize)
  window.addEventListener('resize', onViewport)

  applySavedSize(host)
  host.style.setProperty('--jarvis-right', `${Math.round(plaquePads().right)}px`)
  requestAnimationFrame(() => clampPlaque(host))

  return () => {
    handle.removeEventListener('pointerdown', onHandleDown)
    handle.removeEventListener('pointermove', onHandleMove)
    handle.removeEventListener('pointerup', stopDrag)
    handle.removeEventListener('pointercancel', stopDrag)
    grip.removeEventListener('pointerdown', onGripDown)
    grip.removeEventListener('pointermove', onGripMove)
    grip.removeEventListener('pointerup', stopResize)
    grip.removeEventListener('pointercancel', stopResize)
    window.removeEventListener('resize', onViewport)
  }
}

function plaqueCardCss(): string {
  return `
    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      height: 100%;
      min-height: 0;
      padding: 12px 14px 16px;
      border: 0;
      border-radius: 16px;
      background: transparent;
      color: #12303a;
      font-family: "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    }
    .grip {
      position: absolute;
      right: 1px;
      bottom: 1px;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
    }
    .grip::before {
      content: "";
      position: absolute;
      right: 4px;
      bottom: 4px;
      width: 8px;
      height: 8px;
      border-right: 2px solid rgba(53, 74, 140, 0.7);
      border-bottom: 2px solid rgba(53, 74, 140, 0.7);
    }
    .handle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      user-select: none;
      cursor: grab;
    }
    .title {
      color: #4a63b5;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .clear,
    .close,
    .x,
    .lang {
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      background: transparent;
      color: #4a63b5;
      cursor: pointer;
    }
    .lang {
      width: auto;
      min-width: 44px;
      padding: 0 6px;
      border: 1px solid rgba(74, 99, 181, 0.4);
      border-radius: 6px;
      font: 600 9px/1 "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.08em;
    }
    .close,
    .x {
      font: 700 18px/1 ui-sans-serif, system-ui, sans-serif;
    }
    .clear svg {
      display: block;
      width: 13px;
      height: 13px;
      margin: 0 auto;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .caption {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      color: #12303a;
      font-size: 15px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .caption::-webkit-scrollbar,
    .list::-webkit-scrollbar,
    .answer::-webkit-scrollbar {
      width: 8px;
    }
    .caption::-webkit-scrollbar-track,
    .list::-webkit-scrollbar-track {
      background: rgba(74, 99, 181, 0.08);
    }
    .caption::-webkit-scrollbar-thumb,
    .list::-webkit-scrollbar-thumb,
    .answer::-webkit-scrollbar-thumb {
      background: rgba(74, 99, 181, 0.35);
      border-radius: 8px;
    }
    .caption p,
    .caption-line {
      margin: 0;
    }
    .caption-line {
      display: grid;
      grid-template-rows: 0fr;
      opacity: 0;
      transform: translateY(8px);
      filter: blur(3px);
      transition:
        grid-template-rows 0.48s ease,
        opacity 0.4s ease,
        transform 0.48s ease,
        filter 0.4s ease;
    }
    .caption-line.in {
      grid-template-rows: 1fr;
      opacity: 1;
      transform: none;
      filter: none;
    }
    .caption-line > span {
      overflow: hidden;
      min-height: 0;
      display: block;
      padding-bottom: 8px;
    }
    .hint {
      color: #5d7d88;
    }
    .list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .row {
      padding: 8px 0;
      border-top: 1px solid rgba(74, 99, 181, 0.14);
    }
    .row:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .head {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .ask {
      flex: 1;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: #12303a;
      font: 500 14px/1.4 "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      text-align: left;
      cursor: pointer;
    }
    .ask:hover {
      color: #4a63b5;
    }
    .ask-alt {
      margin: 4px 0 0;
      padding-right: 30px;
      color: #5d6780;
      font-size: 13px;
      line-height: 1.35;
    }
    .pair {
      margin: 0;
    }
    .pair + .pair {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(74, 99, 181, 0.12);
    }
    .pair span {
      display: inline-block;
      margin-right: 6px;
      color: #4a63b5;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.12em;
    }
    .answer {
      margin: 6px 0 0;
      max-height: 22em;
      overflow-y: auto;
      padding: 8px;
      border: 1px solid rgba(74, 99, 181, 0.16);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.28);
      color: #234854;
      font-size: 13px;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    .answer .code {
      display: block;
      margin: 8px 0 0;
      padding: 8px;
      border-radius: 8px;
      background: rgba(18, 48, 58, 0.08);
      color: #12303a;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      overflow-x: auto;
    }
    .answer.error {
      color: #d24b5c;
      border-color: rgba(210, 75, 92, 0.4);
      background: rgba(255, 236, 238, 0.42);
    }
    @media (prefers-reduced-motion: reduce) {
      .caption-line {
        grid-template-rows: 1fr;
        opacity: 1;
        transform: none;
        filter: none;
        transition: none;
      }
    }
  `
}

function sweepOldHosts(): void {
  document
    .querySelectorAll(
      '#jarvis-caption-hud, #jarvis-hud, #jarvis-overlay-host, #jarvis-plaque-original, #jarvis-plaque-translation, #jarvis-plaque-questions, [data-jarvis-hud]',
    )
    .forEach((node) => node.remove())
}

function createPlaque(options: {
  id: string
  kind: PlaqueKind
  title: string
  onClose: () => void
  onClear: () => void
}): {
  mount: (root: Element) => void
  setOpen: (open: boolean) => void
  setTitle: (text: string) => void
  append: (text: string) => void
  showHint: (text: string) => void
  clear: () => void
  remove: () => void
} {
  const host = document.createElement('div')
  host.id = options.id
  host.setAttribute('data-jarvis-hud', String(HUD_REV))
  host.setAttribute('data-kind', options.kind)

  const shadow = host.attachShadow({ mode: 'open' })
  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML = `
    <div class="handle">
      <span class="title"></span>
      <div class="actions">
        <button class="clear" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 7h14M9.2 7l.7 12.4h4.2L14.8 7M10 7V5.6h4V7M10 11.2v5.2M14 11.2v5.2" />
          </svg>
        </button>
        <button class="close" type="button">×</button>
      </div>
    </div>
    <div class="caption"></div>
    <div class="grip" aria-hidden="true"></div>
  `
  const css = document.createElement('style')
  css.textContent = plaqueCardCss()
  shadow.append(css, card)
  const titleEl = shadow.querySelector('.title') as HTMLElement
  const close = shadow.querySelector('.close') as HTMLButtonElement
  const clearBtn = shadow.querySelector('.clear') as HTMLButtonElement
  const handle = shadow.querySelector('.handle') as HTMLElement
  const grip = shadow.querySelector('.grip') as HTMLElement
  const captionEl = shadow.querySelector('.caption') as HTMLElement
  titleEl.textContent = options.title
  close.setAttribute('aria-label', chrome.i18n.getMessage('overlayClose') || 'Close')
  clearBtn.setAttribute('aria-label', chrome.i18n.getMessage('clearCaption') || 'Clear')

  close.addEventListener('pointerdown', (event) => event.stopPropagation())
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onClose()
  })
  clearBtn.addEventListener('pointerdown', (event) => event.stopPropagation())
  clearBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onClear()
  })
  const unbindFrame = bindPlaqueFrame(host, handle, grip, [close, clearBtn])

  return {
    mount(root) {
      if (host.parentNode !== root) {
        root.append(host)
      }
    },
    setOpen(open) {
      host.setAttribute('data-open', open ? '1' : '0')
      host.style.setProperty('display', open ? 'block' : 'none', 'important')
      if (open) {
        requestAnimationFrame(() => clampPlaque(host))
      }
    },
    setTitle(text) {
      titleEl.textContent = text
    },
    append(text) {
      captionEl.querySelector('.hint')?.remove()
      const line = document.createElement('p')
      line.className = 'caption-line'
      const inner = document.createElement('span')
      inner.textContent = text
      line.append(inner)
      captionEl.append(line)
      requestAnimationFrame(() => {
        line.classList.add('in')
      })
      followBottom(captionEl)
    },
    showHint(text) {
      const hint = document.createElement('p')
      hint.className = 'hint'
      hint.textContent = text
      captionEl.replaceChildren(hint)
    },
    clear() {
      captionEl.replaceChildren()
    },
    remove() {
      unbindFrame()
      host.remove()
    },
  }
}

function createScanPlaque(options: {
  id: string
  title: string
  analyzeLabel: string
  onAnalyze: () => void
  onClose: () => void
}): {
  mount: (root: Element) => void
  setOpen: (open: boolean) => void
  setBusy: (busy: boolean) => void
  isOpen: () => boolean
  rect: () => DOMRect | null
  unmount: () => void
} {
  const host = document.createElement('div')
  host.id = options.id
  host.setAttribute('data-jarvis-hud', String(HUD_REV))
  host.setAttribute('data-kind', 'scan')

  const shadow = host.attachShadow({ mode: 'open' })
  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML = `
    <div class="handle">
      <span class="title"></span>
      <div class="actions">
        <button class="go" type="button"></button>
        <button class="close" type="button">×</button>
      </div>
    </div>
    <div class="grip" aria-hidden="true"></div>
    <div class="wait" aria-hidden="true"><span class="spin"></span></div>
  `
  const css = document.createElement('style')
  css.textContent =
    plaqueCardCss() +
    `
    .card {
      padding: 8px 10px 14px;
    }
    .handle {
      margin-bottom: 0;
      padding: 4px 6px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.82);
    }
    .go {
      height: 22px;
      padding: 0 8px;
      border: 1px solid rgba(62, 220, 232, 0.7);
      border-radius: 6px;
      background: rgba(62, 220, 232, 0.16);
      color: #0f6f78;
      font: 600 10px/1 "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .grip {
      width: 22px;
      height: 22px;
    }
    .wait {
      display: none;
      place-items: center;
      height: 100%;
    }
    .card.busy .handle,
    .card.busy .grip {
      display: none;
    }
    .card.busy .wait {
      display: grid;
    }
    .spin {
      width: 22px;
      height: 22px;
      border: 2px solid rgba(62, 220, 232, 0.28);
      border-top-color: #2bb8c4;
      border-radius: 50%;
      animation: jarvis-spin 0.7s linear infinite;
    }
    @keyframes jarvis-spin {
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .spin { animation-duration: 1.4s; }
    }
  `
  shadow.append(css, card)
  const titleEl = shadow.querySelector('.title') as HTMLElement
  const close = shadow.querySelector('.close') as HTMLButtonElement
  const go = shadow.querySelector('.go') as HTMLButtonElement
  const handle = shadow.querySelector('.handle') as HTMLElement
  const grip = shadow.querySelector('.grip') as HTMLElement
  titleEl.textContent = options.title
  go.textContent = options.analyzeLabel
  close.setAttribute('aria-label', chrome.i18n.getMessage('overlayClose') || 'Close')

  close.addEventListener('pointerdown', (event) => event.stopPropagation())
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onClose()
  })
  go.addEventListener('pointerdown', (event) => event.stopPropagation())
  go.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onAnalyze()
  })
  const unbindFrame = bindPlaqueFrame(host, handle, grip, [close, go])

  return {
    mount(root) {
      if (host.parentNode !== root) {
        root.append(host)
      }
    },
    setOpen(open) {
      if (open) {
        const root = document.fullscreenElement ?? document.documentElement
        if (host.parentNode !== root) {
          root.append(host)
        }
      }
      if (!open) {
        host.setAttribute('data-busy', '0')
        card.classList.remove('busy')
      }
      host.setAttribute('data-open', open ? '1' : '0')
      host.style.setProperty('display', open ? 'block' : 'none', 'important')
      host.style.setProperty('visibility', open ? 'visible' : 'hidden', 'important')
      host.style.setProperty('opacity', open ? '1' : '0', 'important')
      if (open && host.getAttribute('data-busy') !== '1') {
        applySavedSize(host)
        requestAnimationFrame(() => {
          clampPlaque(host)
          placeScanIfLost(host)
        })
      }
    },
    setBusy(busy) {
      const wasBusy = host.getAttribute('data-busy') === '1'
      host.setAttribute('data-busy', busy ? '1' : '0')
      card.classList.toggle('busy', busy)
      if (busy) {
        const root = document.fullscreenElement ?? document.documentElement
        if (host.parentNode !== root) {
          root.append(host)
        }
        host.setAttribute('data-open', '1')
        host.style.setProperty('display', 'block', 'important')
        host.style.setProperty('visibility', 'visible', 'important')
        host.style.setProperty('opacity', '1', 'important')
        return
      }
      if (wasBusy) {
        applySavedSize(host)
        requestAnimationFrame(() => {
          clampPlaque(host)
          placeScanIfLost(host)
        })
      }
    },
    isOpen() {
      return host.getAttribute('data-open') === '1' && host.style.display !== 'none'
    },
    rect() {
      const box = host.getBoundingClientRect()
      return box.width > 8 && box.height > 8 ? box : null
    },
    unmount() {
      unbindFrame()
      host.remove()
    },
  }
}

function createQuestionsPlaque(options: {
  id: string
  title: string
  onCloseAll: () => void
  onDismiss: (id: string) => void
  onAsk: (id: string) => void
}): {
  mount: (root: Element) => void
  setOpen: (open: boolean) => void
  upsert: (id: string, payload: { question: string; questionEn?: string; questionRu?: string }) => void
  drop: (id: string) => void
  setAnswer: (
    id: string,
    payload: { answer?: string; answerEn?: string; answerRu?: string; code?: string; error?: string },
  ) => void
  clear: () => void
  ids: () => string[]
  unmount: () => void
} {
  type QuestionLang = 'both' | 'en' | 'ru'
  type Item = {
    id: string
    question: string
    questionEn: string
    questionRu: string
    answer: string
    answerEn: string
    answerRu: string
    code: string
    error: string
    loading: boolean
    open: boolean
  }
  const items: Item[] = []
  let questionLang: QuestionLang = 'both'
  const host = document.createElement('div')
  host.id = options.id
  host.setAttribute('data-jarvis-hud', String(HUD_REV))
  host.setAttribute('data-kind', 'questions')

  const shadow = host.attachShadow({ mode: 'open' })
  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML = `
    <div class="handle">
      <span class="title"></span>
      <div class="actions">
        <button class="lang" type="button">EN+RU</button>
        <button class="close" type="button">×</button>
      </div>
    </div>
    <div class="list"></div>
    <div class="grip" aria-hidden="true"></div>
  `
  const css = document.createElement('style')
  css.textContent = plaqueCardCss()
  shadow.append(css, card)
  const titleEl = shadow.querySelector('.title') as HTMLElement
  const close = shadow.querySelector('.close') as HTMLButtonElement
  const langBtn = shadow.querySelector('.lang') as HTMLButtonElement
  const handle = shadow.querySelector('.handle') as HTMLElement
  const grip = shadow.querySelector('.grip') as HTMLElement
  const listEl = shadow.querySelector('.list') as HTMLElement
  titleEl.textContent = options.title
  close.setAttribute('aria-label', chrome.i18n.getMessage('overlayQuestionsClose') || 'Hide all questions')
  langBtn.setAttribute('aria-label', chrome.i18n.getMessage('overlayQuestionLang') || 'Question language')

  close.addEventListener('pointerdown', (event) => event.stopPropagation())
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onCloseAll()
  })
  langBtn.addEventListener('pointerdown', (event) => event.stopPropagation())
  langBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    questionLang = questionLang === 'both' ? 'en' : questionLang === 'en' ? 'ru' : 'both'
    paintLang()
    paint()
    void chrome.storage.local.set({ questionLang })
  })
  const unbindFrame = bindPlaqueFrame(host, handle, grip, [close, langBtn])

  void chrome.storage.local.get({ questionLang: 'both' }).then((stored) => {
    if (stored.questionLang === 'en' || stored.questionLang === 'ru' || stored.questionLang === 'both') {
      questionLang = stored.questionLang
      paintLang()
      paint()
    }
  })

  function paintLang(): void {
    langBtn.textContent =
      questionLang === 'en'
        ? chrome.i18n.getMessage('questionLangEn') || 'EN'
        : questionLang === 'ru'
          ? chrome.i18n.getMessage('questionLangRu') || 'RU'
          : chrome.i18n.getMessage('questionLangBoth') || 'EN+RU'
  }

  function questionLines(item: Item): { main: string; alt: string } {
    const en = item.questionEn || item.question
    const ru = item.questionRu || item.question
    if (questionLang === 'en') {
      return { main: en, alt: '' }
    }
    if (questionLang === 'ru') {
      return { main: ru, alt: '' }
    }
    return { main: en, alt: ru !== en ? ru : '' }
  }

  function answerLines(item: Item): Array<{ label: string; text: string }> {
    if (item.error || item.loading) {
      return []
    }
    const en = item.answerEn.trim()
    const ru = item.answerRu.trim()
    if (questionLang === 'en') {
      return en ? [{ label: '', text: en }] : ru ? [{ label: '', text: ru }] : []
    }
    if (questionLang === 'ru') {
      return ru ? [{ label: '', text: ru }] : en ? [{ label: '', text: en }] : []
    }
    const lines: Array<{ label: string; text: string }> = []
    if (en) {
      lines.push({ label: 'EN', text: en })
    }
    if (ru && ru !== en) {
      lines.push({ label: 'RU', text: ru })
    }
    if (lines.length === 0 && item.answer.trim()) {
      lines.push({ label: '', text: item.answer.trim() })
    }
    return lines
  }

  function paint(): void {
    const loadingLabel = chrome.i18n.getMessage('questionAnswerLoading') || '…'
    const dismissLabel = chrome.i18n.getMessage('overlayQuestionDismiss') || 'Hide'
    listEl.replaceChildren()
    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'row'
      const head = document.createElement('div')
      head.className = 'head'
      const ask = document.createElement('button')
      ask.className = 'ask'
      ask.type = 'button'
      const lines = questionLines(item)
      ask.textContent = lines.main
      ask.addEventListener('click', () => {
        if (item.open && !item.loading && (item.answer || item.answerEn || item.answerRu || item.code || item.error)) {
          item.open = false
          paint()
          return
        }
        item.open = true
        if (item.loading) {
          options.onAsk(item.id)
          paint()
          return
        }
        if (!item.answer && !item.answerEn && !item.answerRu && !item.code && !item.error) {
          item.loading = true
          options.onAsk(item.id)
        }
        paint()
      })
      const x = document.createElement('button')
      x.className = 'x'
      x.type = 'button'
      x.textContent = '×'
      x.setAttribute('aria-label', dismissLabel)
      x.addEventListener('click', (event) => {
        event.stopPropagation()
        const index = items.findIndex((entry) => entry.id === item.id)
        if (index >= 0) {
          items.splice(index, 1)
        }
        paint()
        options.onDismiss(item.id)
      })
      head.append(ask, x)
      row.append(head)
      if (lines.alt) {
        const alt = document.createElement('div')
        alt.className = 'ask-alt'
        alt.textContent = lines.alt
        row.append(alt)
      }
      if (item.open) {
        const answer = document.createElement('div')
        answer.className = item.error ? 'answer error' : 'answer'
        if (item.loading) {
          answer.textContent = loadingLabel
        } else if (item.error) {
          answer.textContent = item.error
        } else {
          const pairs = answerLines(item)
          if (pairs.length === 1 && !pairs[0].label) {
            answer.append(document.createTextNode(pairs[0].text))
          } else {
            for (const pair of pairs) {
              const line = document.createElement('p')
              line.className = 'pair'
              const label = document.createElement('span')
              label.textContent = pair.label
              line.append(label, document.createTextNode(pair.text))
              answer.append(line)
            }
          }
          if (item.code) {
            const code = document.createElement('pre')
            code.className = 'code'
            code.textContent = item.code
            answer.append(code)
          }
        }
        row.append(answer)
      }
      listEl.append(row)
    }
  }

  paintLang()

  return {
    mount(root) {
      if (host.parentNode !== root) {
        root.append(host)
      }
    },
    setOpen(open) {
      host.setAttribute('data-open', open ? '1' : '0')
      host.style.setProperty('display', open ? 'block' : 'none', 'important')
      if (open) {
        requestAnimationFrame(() => clampPlaque(host))
      }
    },
    upsert(id, payload) {
      const existing = items.find((item) => item.id === id)
      if (existing) {
        existing.question = payload.question
        existing.questionEn = payload.questionEn ?? existing.questionEn
        existing.questionRu = payload.questionRu ?? existing.questionRu
        paint()
        return
      }
      items.push({
        id,
        question: payload.question,
        questionEn: payload.questionEn ?? '',
        questionRu: payload.questionRu ?? '',
        answer: '',
        answerEn: '',
        answerRu: '',
        code: '',
        error: '',
        loading: false,
        open: false,
      })
      while (items.length > 8) {
        items.shift()
      }
      paint()
    },
    drop(id) {
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) {
        return
      }
      items.splice(index, 1)
      paint()
    },
    setAnswer(id, payload) {
      const item = items.find((entry) => entry.id === id)
      if (!item) {
        return
      }
      item.loading = false
      item.open = true
      item.error = payload.error?.trim() ?? ''
      if (payload.answer !== undefined) {
        item.answer = payload.answer.trim()
      }
      if (payload.answerEn !== undefined) {
        item.answerEn = payload.answerEn.trim()
      }
      if (payload.answerRu !== undefined) {
        item.answerRu = payload.answerRu.trim()
      }
      if (payload.code !== undefined) {
        item.code = payload.code.trim()
      }
      paint()
    },
    clear() {
      items.length = 0
      paint()
    },
    ids() {
      return items.map((item) => item.id)
    },
    unmount() {
      unbindFrame()
      host.remove()
    },
  }
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
})()
