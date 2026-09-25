import { type TranslateDirection } from './storage.js'

type TranslatorAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable'

type ChromeTranslator = {
  translate(input: string): Promise<string>
}

type TranslatorStatic = {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorAvailability>
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslator>
}

const chromeTranslators = new Map<string, Promise<ChromeTranslator>>()

export async function translateViaGoogle(text: string, direction: TranslateDirection): Promise<string> {
  const source = direction === 'en-ru' ? 'en' : 'ru'
  const target = direction === 'en-ru' ? 'ru' : 'en'
  let lastError = 'Google Translate failed'
  for (const url of [gtxUrl(text, source, target), chromeDictUrl(text, source, target)]) {
    try {
      const translated = await fetchGoogleTranslation(url)
      if (translated) {
        return translated
      }
      lastError = 'Google Translate returned an empty translation'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  try {
    const local = await translateViaChrome(text, source, target)
    if (local) {
      return local
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
  }
  throw new Error(lastError)
}

async function fetchGoogleTranslation(url: string): Promise<string> {
  const response = await fetch(url)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  if (looksBlocked(body)) {
    throw new Error('HTTP 429')
  }
  return parseGoogleTranslate(JSON.parse(body) as unknown)
}

async function translateViaChrome(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  const Translator = (globalThis as { Translator?: TranslatorStatic }).Translator
  if (!Translator) {
    return ''
  }
  const options = { sourceLanguage, targetLanguage }
  const availability = await Translator.availability(options)
  if (availability === 'unavailable') {
    return ''
  }
  const key = `${sourceLanguage}:${targetLanguage}`
  let pending = chromeTranslators.get(key)
  if (!pending) {
    pending = Translator.create(options)
    chromeTranslators.set(key, pending)
    pending.catch(() => chromeTranslators.delete(key))
  }
  const translator = await pending
  return (await translator.translate(text)).trim()
}

function gtxUrl(text: string, source: string, target: string): string {
  const url = new URL('https://translate.googleapis.com/translate_a/single')
  url.searchParams.set('client', 'gtx')
  url.searchParams.set('sl', source)
  url.searchParams.set('tl', target)
  url.searchParams.set('dt', 't')
  url.searchParams.set('ie', 'UTF-8')
  url.searchParams.set('oe', 'UTF-8')
  url.searchParams.set('q', text)
  return url.toString()
}

function chromeDictUrl(text: string, source: string, target: string): string {
  const url = new URL('https://clients5.google.com/translate_a/t')
  url.searchParams.set('client', 'dict-chrome-ex')
  url.searchParams.set('sl', source)
  url.searchParams.set('tl', target)
  url.searchParams.set('q', text)
  return url.toString()
}

function looksBlocked(body: string): boolean {
  const trimmed = body.trimStart()
  return trimmed.startsWith('<') || trimmed.includes("We're sorry") || trimmed.includes('automated queries')
}

function parseGoogleTranslate(data: unknown): string {
  if (typeof data === 'string') {
    return decodeHtml(data)
  }
  if (!Array.isArray(data) || data.length === 0) {
    return ''
  }
  if (typeof data[0] === 'string') {
    return decodeHtml(data.filter((part): part is string => typeof part === 'string').join(''))
  }
  if (!Array.isArray(data[0])) {
    return ''
  }
  return decodeHtml(
    data[0]
      .map((part) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''))
      .join(''),
  )
}

function decodeHtml(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim()
}
