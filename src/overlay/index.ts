type HudHandle = { teardown: () => void; enable: () => void }
type PlaqueKind = 'original' | 'translation'

const overlayWindow = window as Window & { __jarvisHud?: HudHandle; __jarvisHudRev?: number }
const HUD_REV = 14
const STYLE_ID = 'jarvis-hud-style'
const HOST_IDS = {
  original: 'jarvis-plaque-original',
  translation: 'jarvis-plaque-translation',
  questions: 'jarvis-plaque-questions',
} as const

if (window === window.top) {
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
    #${HOST_IDS.questions} {
      all: initial;
      position: fixed !important;
      z-index: 2147483647 !important;
      width: min(420px, 42vw) !important;
      margin: 0 !important;
      padding: 0 !important;
      display: none !important;
      box-sizing: border-box !important;
      pointer-events: auto !important;
    }
    #${HOST_IDS.original} {
      left: 24px !important;
      bottom: 24px !important;
      top: auto !important;
      right: auto !important;
    }
    #${HOST_IDS.translation} {
      right: 24px !important;
      bottom: 24px !important;
      top: auto !important;
      left: auto !important;
    }
    #${HOST_IDS.questions} {
      left: 50% !important;
      top: 24px !important;
      right: auto !important;
      bottom: auto !important;
      width: min(520px, 56vw) !important;
      transform: translateX(-50%) !important;
    }
    #${HOST_IDS.original}[data-open="1"],
    #${HOST_IDS.translation}[data-open="1"],
    #${HOST_IDS.questions}[data-open="1"] {
      display: block !important;
    }
    @media (max-width: 900px) {
      #${HOST_IDS.original},
      #${HOST_IDS.translation},
      #${HOST_IDS.questions} {
        width: min(720px, 90vw) !important;
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
      const ids = questionsPlaque.ids()
      questionsPlaque.clear()
      render()
      for (const id of ids) {
        void chrome.runtime.sendMessage({ type: 'DISMISS_OVERLAY_QUESTION', id }).catch(() => undefined)
      }
    },
    onDismiss(id) {
      void chrome.runtime.sendMessage({ type: 'DISMISS_OVERLAY_QUESTION', id }).catch(() => undefined)
      render()
    },
    onAsk(id) {
      void chrome.runtime.sendMessage({ type: 'REQUEST_OVERLAY_ANSWER', id }).catch(() => undefined)
    },
  })

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
  }

  function onMessage(message: {
    type?: string
    original?: string
    translation?: string
    direction?: 'en-ru' | 'ru-en'
    target?: 'original' | 'translation'
    id?: string
    question?: string
    answer?: string
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
    if (message.type === 'SHOW_OVERLAY_QUESTION' && message.id && message.question) {
      closedQuestions = false
      questionsPlaque.upsert(message.id, message.question)
      render()
      return
    }
    if (message.type === 'DISMISS_OVERLAY_QUESTION' && message.id) {
      questionsPlaque.drop(message.id)
      render()
      return
    }
    if (message.type === 'SHOW_OVERLAY_ANSWER' && message.id) {
      questionsPlaque.setAnswer(message.id, message.answer, message.error)
      render()
      return
    }
    if (message.type === 'CLEAR_OVERLAY_QUESTIONS') {
      questionsPlaque.clear()
      closedQuestions = false
      render()
      return
    }
    if (message.type === 'DISABLE_OVERLAY') {
      visible = false
      originals.length = 0
      translations.length = 0
      lastOriginal = ''
      originalPlaque.clear()
      translationPlaque.clear()
      questionsPlaque.clear()
      closedQuestions = false
      render()
    }
  }

  chrome.runtime.onMessage.addListener(onMessage)
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
    teardown() {
      chrome.runtime.onMessage.removeListener(onMessage)
      document.removeEventListener('fullscreenchange', mount)
      window.clearInterval(meter)
      originalPlaque.remove()
      translationPlaque.remove()
      questionsPlaque.unmount()
      pageStyle.remove()
    },
  }
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
  `
  const css = document.createElement('style')
  css.textContent = `
    .card {
      box-sizing: border-box;
      padding: 10px 12px 12px;
      border: 1px solid rgba(122, 240, 255, 0.35);
      background: rgba(5, 12, 18, 0.78);
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), inset 0 0 24px rgba(122, 240, 255, 0.06);
      color: #e8fbff;
      font-family: "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
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
      color: #e2b45a;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .clear,
    .close {
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      background: transparent;
      color: #7af0ff;
      cursor: pointer;
    }
    .close {
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
      height: calc(16em / 1.5);
      overflow-y: auto;
      overscroll-behavior: contain;
      color: #e8fbff;
      font-size: 15px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .caption::-webkit-scrollbar {
      width: 8px;
    }
    .caption::-webkit-scrollbar-track {
      background: rgba(122, 240, 255, 0.08);
    }
    .caption::-webkit-scrollbar-thumb {
      background: rgba(122, 240, 255, 0.45);
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
      color: #7d97a3;
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
  shadow.append(css, card)
  const titleEl = shadow.querySelector('.title') as HTMLElement
  const close = shadow.querySelector('.close') as HTMLButtonElement
  const clearBtn = shadow.querySelector('.clear') as HTMLButtonElement
  const handle = shadow.querySelector('.handle') as HTMLElement
  const captionEl = shadow.querySelector('.caption') as HTMLElement
  titleEl.textContent = options.title
  close.setAttribute('aria-label', chrome.i18n.getMessage('overlayClose') || 'Close')
  clearBtn.setAttribute('aria-label', chrome.i18n.getMessage('clearCaption') || 'Clear')

  let dragging = false
  let offsetX = 0
  let offsetY = 0

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

  handle.addEventListener('pointerdown', (event) => {
    const target = event.target as Node
    if (target === close || close.contains(target) || target === clearBtn || clearBtn.contains(target)) {
      return
    }
    dragging = true
    const rect = host.getBoundingClientRect()
    offsetX = event.clientX - rect.left
    offsetY = event.clientY - rect.top
    host.style.setProperty('left', `${rect.left}px`, 'important')
    host.style.setProperty('top', `${rect.top}px`, 'important')
    host.style.setProperty('right', 'auto', 'important')
    host.style.setProperty('bottom', 'auto', 'important')
    host.style.setProperty('transform', 'none', 'important')
    handle.setPointerCapture(event.pointerId)
  })
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return
    }
    host.style.setProperty('left', `${Math.max(8, event.clientX - offsetX)}px`, 'important')
    host.style.setProperty('top', `${Math.max(8, event.clientY - offsetY)}px`, 'important')
  })
  handle.addEventListener('pointerup', () => {
    dragging = false
  })
  handle.addEventListener('pointercancel', () => {
    dragging = false
  })

  return {
    mount(root) {
      if (host.parentNode !== root) {
        root.append(host)
      }
    },
    setOpen(open) {
      host.setAttribute('data-open', open ? '1' : '0')
      host.style.setProperty('display', open ? 'block' : 'none', 'important')
    },
    setTitle(text) {
      titleEl.textContent = text
    },
    append(text) {
      captionEl.querySelector('.hint')?.remove()
      const stick = isNearBottom(captionEl)
      const line = document.createElement('p')
      line.className = 'caption-line'
      const inner = document.createElement('span')
      inner.textContent = text
      line.append(inner)
      captionEl.append(line)
      requestAnimationFrame(() => {
        line.classList.add('in')
      })
      if (stick) {
        followBottom(captionEl)
      }
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
  upsert: (id: string, question: string) => void
  drop: (id: string) => void
  setAnswer: (id: string, answer?: string, error?: string) => void
  clear: () => void
  ids: () => string[]
  unmount: () => void
} {
  type Item = {
    id: string
    question: string
    answer: string
    error: string
    loading: boolean
    open: boolean
  }
  const items: Item[] = []
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
      <button class="close" type="button">×</button>
    </div>
    <div class="list"></div>
  `
  const css = document.createElement('style')
  css.textContent = `
    .card {
      box-sizing: border-box;
      padding: 10px 12px 12px;
      border: 1px solid rgba(122, 240, 255, 0.35);
      background: rgba(5, 12, 18, 0.78);
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), inset 0 0 24px rgba(122, 240, 255, 0.06);
      color: #e8fbff;
      font-family: "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
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
      color: #e2b45a;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .close {
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      background: transparent;
      color: #7af0ff;
      font: 700 18px/1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }
    .list {
      max-height: 16em;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .list::-webkit-scrollbar {
      width: 8px;
    }
    .list::-webkit-scrollbar-thumb {
      background: rgba(122, 240, 255, 0.45);
    }
    .row {
      padding: 8px 0;
      border-top: 1px solid rgba(122, 240, 255, 0.14);
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
      color: #e8fbff;
      font: 500 14px/1.4 "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      text-align: left;
      cursor: pointer;
    }
    .ask:hover {
      color: #7af0ff;
    }
    .x {
      flex: 0 0 22px;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      background: transparent;
      color: #7af0ff;
      font: 700 16px/1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }
    .answer {
      margin: 6px 0 0;
      max-height: 6.4em;
      overflow-y: auto;
      padding: 8px;
      border: 1px solid rgba(122, 240, 255, 0.2);
      background: rgba(5, 12, 18, 0.45);
      color: #cfeaf0;
      font-size: 13px;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    .answer.error {
      color: #f07178;
      border-color: rgba(240, 113, 120, 0.4);
    }
  `
  shadow.append(css, card)
  const titleEl = shadow.querySelector('.title') as HTMLElement
  const close = shadow.querySelector('.close') as HTMLButtonElement
  const handle = shadow.querySelector('.handle') as HTMLElement
  const listEl = shadow.querySelector('.list') as HTMLElement
  titleEl.textContent = options.title
  close.setAttribute('aria-label', chrome.i18n.getMessage('overlayQuestionsClose') || 'Hide all questions')

  let dragging = false
  let offsetX = 0
  let offsetY = 0
  close.addEventListener('pointerdown', (event) => event.stopPropagation())
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    options.onCloseAll()
  })
  handle.addEventListener('pointerdown', (event) => {
    if (event.target === close || close.contains(event.target as Node)) {
      return
    }
    dragging = true
    const rect = host.getBoundingClientRect()
    offsetX = event.clientX - rect.left
    offsetY = event.clientY - rect.top
    host.style.setProperty('left', `${rect.left}px`, 'important')
    host.style.setProperty('top', `${rect.top}px`, 'important')
    host.style.setProperty('right', 'auto', 'important')
    host.style.setProperty('bottom', 'auto', 'important')
    host.style.setProperty('transform', 'none', 'important')
    handle.setPointerCapture(event.pointerId)
  })
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return
    }
    host.style.setProperty('left', `${Math.max(8, event.clientX - offsetX)}px`, 'important')
    host.style.setProperty('top', `${Math.max(8, event.clientY - offsetY)}px`, 'important')
  })
  handle.addEventListener('pointerup', () => {
    dragging = false
  })
  handle.addEventListener('pointercancel', () => {
    dragging = false
  })

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
      ask.textContent = item.question
      ask.addEventListener('click', () => {
        if (item.open && !item.loading && (item.answer || item.error)) {
          item.open = false
          paint()
          return
        }
        item.open = true
        if (!item.answer && !item.error && !item.loading) {
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
      if (item.open) {
        const answer = document.createElement('div')
        answer.className = item.error ? 'answer error' : 'answer'
        answer.textContent = item.loading ? loadingLabel : item.error || item.answer
        row.append(answer)
      }
      listEl.append(row)
    }
  }

  return {
    mount(root) {
      if (host.parentNode !== root) {
        root.append(host)
      }
    },
    setOpen(open) {
      host.setAttribute('data-open', open ? '1' : '0')
      host.style.setProperty('display', open ? 'block' : 'none', 'important')
    },
    upsert(id, question) {
      const existing = items.find((item) => item.id === id)
      if (existing) {
        existing.question = question
        paint()
        return
      }
      items.push({ id, question, answer: '', error: '', loading: false, open: false })
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
    setAnswer(id, answer, error) {
      const item = items.find((entry) => entry.id === id)
      if (!item) {
        return
      }
      item.loading = false
      item.open = true
      item.answer = answer?.trim() ?? ''
      item.error = error?.trim() ?? ''
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
