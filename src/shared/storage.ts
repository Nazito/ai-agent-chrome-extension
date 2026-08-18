export type ProviderId = 'openai' | 'groq' | 'gemini'

export const PROVIDERS: ProviderId[] = ['openai', 'groq', 'gemini']

export type TranslateDirection = 'en-ru' | 'ru-en'

export type LlmSettings = {
  provider: ProviderId
  keys: Record<ProviderId, string>
}

export function isTranslateDirection(value: unknown): value is TranslateDirection {
  return value === 'en-ru' || value === 'ru-en'
}

export async function loadTranslateDirection(): Promise<TranslateDirection> {
  const stored = await chrome.storage.local.get({ translateDirection: 'en-ru' })
  return isTranslateDirection(stored.translateDirection) ? stored.translateDirection : 'en-ru'
}

export async function saveTranslateDirection(direction: TranslateDirection): Promise<void> {
  await chrome.storage.local.set({ translateDirection: direction })
}

const EMPTY_KEYS: Record<ProviderId, string> = {
  openai: '',
  groq: '',
  gemini: '',
}

export async function loadLlmSettings(): Promise<LlmSettings> {
  const stored = await chrome.storage.local.get({
    provider: 'openai',
    apiKey: '',
    groqKey: '',
    geminiKey: '',
  })

  return {
    provider: isProvider(stored.provider) ? stored.provider : 'openai',
    keys: {
      openai: String(stored.apiKey ?? ''),
      groq: String(stored.groqKey ?? ''),
      gemini: String(stored.geminiKey ?? ''),
    },
  }
}

export async function saveProvider(provider: ProviderId): Promise<void> {
  await chrome.storage.local.set({ provider })
}

export async function saveProviderKey(provider: ProviderId, apiKey: string): Promise<void> {
  if (provider === 'openai') {
    await chrome.storage.local.set({ apiKey })
    return
  }
  if (provider === 'groq') {
    await chrome.storage.local.set({ groqKey: apiKey })
    return
  }
  await chrome.storage.local.set({ geminiKey: apiKey })
}

export function isProvider(value: unknown): value is ProviderId {
  return value === 'openai' || value === 'groq' || value === 'gemini'
}

export function emptyKeys(): Record<ProviderId, string> {
  return { ...EMPTY_KEYS }
}

export function uiLanguage(): 'ru' | 'en' {
  return chrome.i18n.getUILanguage().toLowerCase().startsWith('ru') ? 'ru' : 'en'
}
