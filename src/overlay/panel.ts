import { MessageType } from '../shared/messages.js'

const kicker = document.querySelector('.kicker')
if (kicker) {
  kicker.textContent = chrome.i18n.getMessage('overlayHandle')
}
const linesEl = document.getElementById('lines')!
const placeholder = document.getElementById('placeholder')!
placeholder.textContent = chrome.i18n.getMessage('overlayWaiting')
document.getElementById('close')!.addEventListener('click', () => {
  void chrome.windows.getCurrent().then((current) => {
    if (current.id !== undefined) {
      void chrome.windows.remove(current.id)
    }
  })
})

const captions: Array<{ original: string; translation: string }> = []

chrome.runtime.onMessage.addListener((message: { type?: string; original?: string; translation?: string }) => {
  if (message.type === MessageType.ShowOverlayCaption) {
    pushCaption(message.original ?? '', message.translation ?? '')
    return
  }
  if (message.type === MessageType.ClearOverlayCaption) {
    captions.length = 0
    render()
  }
})

function pushCaption(original: string, translation: string): void {
  const last = captions[captions.length - 1]
  if (last && last.original === original) {
    last.translation = translation || last.translation
  } else if (original || translation) {
    captions.push({ original, translation })
    if (captions.length > 2) {
      captions.shift()
    }
  }
  render()
}

function render(): void {
  if (captions.length === 0) {
    linesEl.replaceChildren(placeholder)
    return
  }
  linesEl.replaceChildren(
    ...captions.map((caption) => {
      const line = document.createElement('div')
      line.className = 'line'
      if (caption.original) {
        const original = document.createElement('p')
        original.className = 'original'
        original.textContent = caption.original
        line.append(original)
      }
      if (caption.translation) {
        const translation = document.createElement('p')
        translation.className = 'translation'
        translation.textContent = caption.translation
        line.append(translation)
      }
      return line
    }),
  )
}
