export type ProviderId = 'openai' | 'groq' | 'gemini'

export const PROVIDERS: ProviderId[] = ['openai', 'groq', 'gemini']

export type TranslateDirection = 'en-ru' | 'ru-en'
export type QuestionLang = 'both' | 'en' | 'ru'

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

export function isQuestionLang(value: unknown): value is QuestionLang {
  return value === 'both' || value === 'en' || value === 'ru'
}

export async function loadQuestionLang(): Promise<QuestionLang> {
  const stored = await chrome.storage.local.get({ questionLang: 'both' })
  return isQuestionLang(stored.questionLang) ? stored.questionLang : 'both'
}

export async function saveQuestionLang(lang: QuestionLang): Promise<void> {
  await chrome.storage.local.set({ questionLang: lang })
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

export const PRESET_BADGES = [
  'job-interview',
  'javascript',
  'typescript',
  'react',
  'frontend',
  'backend',
  'system-design',
  'code-review',
  'one-on-one',
  'standup',
] as const

export const PROFILE_QUESTIONS = [
  'name',
  'role',
  'experience',
  'stack',
  'goal',
  'languages',
  'notes',
] as const

export type ProfileQuestionId = (typeof PROFILE_QUESTIONS)[number]

export type MeetingProfile = {
  profile: string
  answers: Record<string, string>
  profileCustom: boolean
  badges: string[]
  customBadges: string[]
}

export async function loadMeetingProfile(): Promise<MeetingProfile> {
  const stored = await chrome.storage.local.get({
    userProfile: '',
    profileAnswers: {} as Record<string, string>,
    profileCustom: false,
    contextBadges: [] as string[],
    customBadges: [] as string[],
  })
  const answers = normalizeAnswers(stored.profileAnswers)
  const profile = String(stored.userProfile ?? '').slice(0, 4000)
  const hasAnswers = PROFILE_QUESTIONS.some((id) => answers[id])
  return {
    profile,
    answers,
    profileCustom: stored.profileCustom === true || (profile.length > 0 && !hasAnswers),
    badges: normalizeBadgeList(stored.contextBadges),
    customBadges: normalizeBadgeList(stored.customBadges),
  }
}

export async function saveMeetingProfile(value: MeetingProfile): Promise<void> {
  await chrome.storage.local.set({
    userProfile: value.profile.slice(0, 4000),
    profileAnswers: normalizeAnswers(value.answers),
    profileCustom: value.profileCustom === true,
    contextBadges: normalizeBadgeList(value.badges),
    customBadges: normalizeBadgeList(value.customBadges),
  })
}

export function compileProfile(
  answers: Record<string, string>,
  label: (id: ProfileQuestionId) => string,
): string {
  return PROFILE_QUESTIONS.map((id) => {
    const value = (answers[id] ?? '').replace(/\s+/g, ' ').trim()
    if (!value) {
      return ''
    }
    return `${label(id)}: ${value}`
  })
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000)
}

function normalizeAnswers(value: unknown): Record<string, string> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const answers: Record<string, string> = {}
  for (const id of PROFILE_QUESTIONS) {
    const raw = (source as Record<string, unknown>)[id]
    const text = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 280)
    if (text) {
      answers[id] = text
    }
  }
  return answers
}

function normalizeBadgeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of value) {
    const badge = String(item ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
    if (!badge || seen.has(badge.toLowerCase())) {
      continue
    }
    seen.add(badge.toLowerCase())
    list.push(badge)
    if (list.length >= 16) {
      break
    }
  }
  return list
}

export function uiLanguage(): 'ru' | 'en' {
  return chrome.i18n.getUILanguage().toLowerCase().startsWith('ru') ? 'ru' : 'en'
}
