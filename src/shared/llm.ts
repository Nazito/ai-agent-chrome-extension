import { type ProviderId, type TranslateDirection } from './storage.js'

export type AnswerContext = {
  profile?: string
  badges?: string[]
}

const TRANSLATE_EN_RU =
  'You translate English speech from a live meeting into natural Russian. Keep meaning and tone. Return only the Russian translation.'
const TRANSLATE_RU_EN =
  'You translate Russian speech from a live meeting into natural English. Keep meaning and tone. Return only the English translation.'
const TRANSCRIBE_EN =
  'Transcribe this English speech. Return only the spoken words. If there is no speech, return nothing.'
const TRANSCRIBE_RU =
  'Transcribe this Russian speech. Return only the spoken words. If there is no speech, return nothing.'

export function sourceLanguage(direction: TranslateDirection): 'en' | 'ru' {
  return direction === 'en-ru' ? 'en' : 'ru'
}

function translatePrompt(direction: TranslateDirection): string {
  return direction === 'en-ru' ? TRANSLATE_EN_RU : TRANSLATE_RU_EN
}

export async function transcribeAudio(
  provider: ProviderId,
  apiKey: string,
  blob: Blob,
  direction: TranslateDirection,
): Promise<string> {
  const language = sourceLanguage(direction)
  if (provider === 'groq') {
    return transcribeOpenAiCompatible(
      'https://api.groq.com/openai/v1',
      apiKey,
      blob,
      ['whisper-large-v3-turbo', 'whisper-large-v3'],
      language,
    )
  }
  if (provider === 'gemini') {
    return geminiGenerate(apiKey, blob, language === 'en' ? TRANSCRIBE_EN : TRANSCRIBE_RU)
  }
  return transcribeOpenAiCompatible(
    'https://api.openai.com/v1',
    apiKey,
    blob,
    ['gpt-4o-mini-transcribe', 'whisper-1'],
    language,
  )
}

export async function translateText(
  provider: ProviderId,
  apiKey: string,
  text: string,
  direction: TranslateDirection,
): Promise<string> {
  const prompt = translatePrompt(direction)
  return chatText(provider, apiKey, text, prompt)
}

const EXTRACT_QUESTIONS_PROMPT = `You extract questions from live meeting speech.
The transcript may be split across chunks. Join a question that was cut mid-sentence into one complete question.
Return JSON only: {"questions":["..."]}
Include only complete questions that expect an answer from listeners or the room.
A question is complete if it has a clear ask and does not end on a dangling word like "the", "to", "about", "and".
Skip rhetorical questions, check-ins ("can you hear me?", "слышно?"), tag questions ("right?", "да?"), and unfinished fragments.
Keep the speaker's original wording, lightly cleaned.
If none, return {"questions":[]}.`

function answerPrompt(context: AnswerContext): string {
  const profile = context.profile?.trim() ?? ''
  const tags = (context.badges ?? [])
    .map((badge) => badge.replace(/-/g, ' ').trim())
    .filter(Boolean)
    .join(', ')
  return `You help a meeting participant answer out loud as themselves.
Return JSON only: {"en":"...","ru":"..."}
No markdown, no XML, no HTML, no thinking, no tags.
Answers are spoken-ready and laconic: 1–4 short sentences, no filler, no greeting, no lists.
Use the profile for personal, career, and skill questions. Do not invent facts that are not in the profile or transcript.
Use the transcript for what was just said. Do not invent meeting facts.
If profile and transcript are not enough, say that briefly.
${profile ? `Speaker profile:\n${profile}\n` : 'No speaker profile is set. If the question is personal, say you do not have that detail.\n'}
${tags ? `Meeting context tags: ${tags}. Tune tone and focus to these tags.\n` : ''}`
}

export function looksRussian(text: string): boolean {
  const cyrillic = (text.match(/[а-яё]/gi) ?? []).length
  const latin = (text.match(/[a-z]/gi) ?? []).length
  return cyrillic > latin
}

export async function extractQuestions(
  provider: ProviderId,
  apiKey: string,
  windowText: string,
): Promise<string[]> {
  if (!windowText.trim()) {
    return []
  }
  const raw = await chatText(provider, apiKey, windowText, EXTRACT_QUESTIONS_PROMPT, true)
  return parseQuestionList(raw)
}

export async function answerQuestion(
  provider: ProviderId,
  apiKey: string,
  question: string,
  transcript: string,
  context: AnswerContext = {},
): Promise<{ en: string; ru: string }> {
  const recent = transcript.trim().split(/\n+/).slice(-16).join('\n')
  const user = recent
    ? `Question:\n${question}\n\nRecent transcript:\n${recent}`
    : `Question:\n${question}`
  const raw = await chatText(provider, apiKey, user, answerPrompt(context), true)
  return parseAnswerPair(raw)
}

export type ScreenTask = {
  hasTask: boolean
  title: string
  task: string
  answerEn: string
  answerRu: string
  code: string
}

export async function analyzeScreenTask(
  provider: ProviderId,
  apiKey: string,
  imageDataUrl: string,
  context: AnswerContext = {},
): Promise<ScreenTask> {
  const compact = await compactScreenshot(imageDataUrl)
  const raw = await chatVision(
    provider,
    apiKey,
    'Read the screenshot and solve it. Return JSON only.',
    screenTaskPrompt(context),
    compact,
  )
  return parseScreenTask(raw)
}

function screenTaskPrompt(context: AnswerContext): string {
  const profile = context.profile?.trim() ?? ''
  const tags = (context.badges ?? [])
    .map((badge) => badge.replace(/-/g, ' ').trim())
    .filter(Boolean)
    .join(', ')
  return `You solve tasks from a screenshot of a live interview, quiz, or coding screen.
Read every visible word, including all multiple-choice options. Do not skip options or tiny text.

Return JSON only:
{"hasTask":false,"title":"","task":"","answerEn":"","answerRu":"","code":""}

Rules:
- hasTask false only if there is no question or problem.
- title: short name. For a quiz, include the chosen option, e.g. "B — map returns a new array".
- task: one sentence, what was asked.
- answerEn / answerRu: the answer to say out loud. 1-3 short sentences each. No markdown, no thinking.
- code: working code only when they must write code. Empty for multiple choice.
- For JavaScript quizzes, execute the snippet as the spec would: hoisting, this, closures, coercion, == vs ===, const/let/var, prototype, event loop, promises, spread/rest, pass-by-reference. Pick the option that matches actual runtime, not the tempting wrong one.
- If several questions are visible, answer the highlighted or first complete one.
${profile ? `Profile:\n${profile}\n` : ''}${tags ? `Tags: ${tags}\n` : ''}`.trim()
}

function chatText(
  provider: ProviderId,
  apiKey: string,
  text: string,
  prompt: string,
  json = false,
): Promise<string> {
  if (provider === 'groq') {
    return chatOpenAiCompatible('https://api.groq.com/openai/v1', apiKey, text, prompt, [
      'openai/gpt-oss-20b',
      'qwen/qwen3.6-27b',
      'openai/gpt-oss-120b',
    ], json)
  }
  if (provider === 'gemini') {
    return geminiGenerate(apiKey, undefined, `${prompt}\n\n${text}`)
  }
  return chatOpenAiCompatible('https://api.openai.com/v1', apiKey, text, prompt, ['gpt-4o-mini'], json)
}

function chatVision(
  provider: ProviderId,
  apiKey: string,
  text: string,
  prompt: string,
  imageDataUrl: string,
): Promise<string> {
  if (provider === 'groq') {
    return chatOpenAiCompatible(
      'https://api.groq.com/openai/v1',
      apiKey,
      text,
      prompt,
      ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'],
      true,
      imageDataUrl,
    )
  }
  if (provider === 'gemini') {
    return geminiGenerate(apiKey, undefined, `${prompt}\n\n${text}`, { imageDataUrl, json: true })
  }
  return chatOpenAiCompatible(
    'https://api.openai.com/v1',
    apiKey,
    text,
    prompt,
    ['gpt-4o-mini', 'gpt-4o'],
    true,
    imageDataUrl,
  )
}

function parseQuestionList(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed) {
    return []
  }
  const json = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/u, '')
  const parsed = tryParseJson(json) ?? tryParseJson(extractJsonObject(json))
  if (!parsed) {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : parsed.questions
  if (!Array.isArray(list)) {
    return []
  }
  return list
    .map((item) => (typeof item === 'string' ? item : String((item as { question?: string }).question ?? '')))
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length > 12 && !isCutQuestion(item))
}

export function isCutQuestion(text: string): boolean {
  const body = text.replace(/[?？.!]+\s*$/u, '').trim()
  if (!body) {
    return true
  }
  return /\b(the|a|an|to|for|of|and|or|in|on|at|with|by|from|about|as|if|that|my|your|our|и|на|по|для|про|чтобы|или)\s*$/iu.test(
    body,
  )
}

function parseAnswerPair(raw: string): { en: string; ru: string } {
  const cleaned = stripModelJunk(raw)
  const json = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/u, '')
  const parsed = tryParseJson(json) ?? tryParseJson(extractJsonObject(json))
  if (parsed && !Array.isArray(parsed)) {
    const en = sanitizeSpokenAnswer(typeof parsed.en === 'string' ? parsed.en : '')
    const ru = sanitizeSpokenAnswer(typeof parsed.ru === 'string' ? parsed.ru : '')
    if (en || ru) {
      return { en, ru }
    }
  }
  const fallback = sanitizeSpokenAnswer(cleaned)
  if (!fallback) {
    return { en: '', ru: '' }
  }
  return looksRussian(fallback) ? { en: '', ru: fallback } : { en: fallback, ru: '' }
}

function parseScreenTask(raw: string): ScreenTask {
  const empty: ScreenTask = { hasTask: false, title: '', task: '', answerEn: '', answerRu: '', code: '' }
  const cleaned = stripModelJunk(raw)
  const json = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/u, '')
  const parsed = tryParseJson(json) ?? tryParseJson(extractJsonObject(json))
  if (!parsed || Array.isArray(parsed)) {
    return empty
  }
  const title = sanitizeScreenProse(typeof parsed.title === 'string' ? parsed.title : '', 120)
  const task = sanitizeScreenProse(
    typeof parsed.task === 'string'
      ? parsed.task
      : typeof parsed.question === 'string'
        ? parsed.question
        : '',
    600,
  )
  const answerFallback =
    typeof parsed.answer === 'string'
      ? parsed.answer
      : typeof parsed.solution === 'string'
        ? parsed.solution
        : ''
  let answerEn = sanitizeScreenProse(typeof parsed.answerEn === 'string' ? parsed.answerEn : '', 1200)
  let answerRu = sanitizeScreenProse(typeof parsed.answerRu === 'string' ? parsed.answerRu : '', 1200)
  if (!answerEn && !answerRu && answerFallback) {
    if (looksRussian(answerFallback)) {
      answerRu = sanitizeScreenProse(answerFallback, 1200)
    } else {
      answerEn = sanitizeScreenProse(answerFallback, 1200)
    }
  }
  const code = sanitizeScreenCode(typeof parsed.code === 'string' ? parsed.code : '')
  const explicitNo = parsed.hasTask === false || parsed.hasTask === 'false'
  if (explicitNo && !answerEn && !answerRu && !code) {
    return empty
  }
  if (!title && !task && !answerEn && !answerRu && !code) {
    return empty
  }
  return { hasTask: true, title, task, answerEn, answerRu, code }
}

function sanitizeScreenProse(text: string, max: number): string {
  const clean = text
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, ' ')
    .replace(/<\/?[a-z][\w:-]*\b[^>]*>/gi, ' ')
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/[*#>`]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return clean.slice(0, max).trim()
}

function sanitizeScreenCode(text: string): string {
  const unfenced = text
    .replace(/^```[\w+-]*\s*/u, '')
    .replace(/\s*```$/u, '')
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/\r\n/g, '\n')
    .trim()
  return unfenced.slice(0, 4000).trim()
}

function stripModelJunk(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, ' ')
    .replace(/<reasoning\b[^>]*>[\s\S]*?(?:<\/reasoning>|$)/gi, ' ')
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/\[\/?(?:INST|SYS|think|reasoning|assistant|system)\]/gi, ' ')
    .replace(/```(?:json|[\w+-]*)?\s*/gi, ' ')
    .replace(/```/g, ' ')
    .trim()
}

function sanitizeSpokenAnswer(text: string): string {
  const clean = text
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, ' ')
    .replace(/<\/?[a-z][\w:-]*\b[^>]*>/gi, ' ')
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/[*_#>`]+/g, ' ')
    .replace(/\\[ntr]/g, ' ')
    .replace(/[{}\[\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s,.;:—–-]+/u, '')
    .replace(/[\s,;:—–-]+$/u, '')
  if (!clean) {
    return ''
  }
  const sentences = clean.split(/(?<=[.!?…])\s+/u).filter(Boolean).slice(0, 4)
  const kept: string[] = []
  let words = 0
  for (const sentence of sentences) {
    const count = sentence.split(/\s+/).filter(Boolean).length
    if (kept.length > 0 && words + count > 70) {
      break
    }
    kept.push(sentence)
    words += count
  }
  return kept.join(' ')
}

function tryParseJson(text: string | null): Record<string, unknown> | unknown[] | null {
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text) as Record<string, unknown> | unknown[]
  } catch {
    return null
  }
}

function extractJsonObject(text: string): string | null {
  const start = text.search(/[\[{]/)
  if (start < 0) {
    return null
  }
  const opener = text[start]
  const closer = opener === '[' ? ']' : '}'
  const end = text.lastIndexOf(closer)
  if (end <= start) {
    return null
  }
  return text.slice(start, end + 1)
}

async function transcribeOpenAiCompatible(
  base: string,
  apiKey: string,
  blob: Blob,
  models: string[],
  language: 'en' | 'ru',
): Promise<string> {
  let lastError = 'Transcription failed'
  for (const model of models) {
    try {
      return await postTranscription(base, apiKey, blob, model, language)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (!isRetryableModelError(lastError)) {
        throw error
      }
    }
  }
  throw new Error(lastError)
}

async function postTranscription(
  base: string,
  apiKey: string,
  blob: Blob,
  model: string,
  language: 'en' | 'ru',
): Promise<string> {
  const extension = blob.type.includes('wav') ? 'wav' : 'webm'
  const form = new FormData()
  form.append('file', blob, `speech.${extension}`)
  form.append('model', model)
  form.append('language', language)
  form.append('response_format', 'json')

  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  const data = (await response.json()) as { text?: string }
  return data.text?.trim() ?? ''
}

async function chatOpenAiCompatible(
  base: string,
  apiKey: string,
  text: string,
  prompt: string,
  models: string[],
  json = false,
  imageDataUrl?: string,
): Promise<string> {
  let lastError = 'Translation failed'
  const userContent = imageDataUrl
    ? [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : text
  for (const model of models) {
    const modes = json ? [true, false] : [false]
    for (const asJson of modes) {
      try {
        const body: Record<string, unknown> = {
          model,
          temperature: imageDataUrl ? 0.1 : 0.2,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: userContent },
          ],
        }
        if (imageDataUrl) {
          body.max_tokens = 1600
          if (base.includes('api.groq.com')) {
            body.reasoning_effort = 'none'
            body.reasoning_format = 'hidden'
          }
        }
        if (asJson) {
          body.response_format = { type: 'json_object' }
        }
        let response = await postChatCompletion(base, apiKey, body)
        if (!response.ok) {
          lastError = await readError(response)
          if (body.reasoning_effort && /reasoning|thinking/i.test(lastError)) {
            delete body.reasoning_effort
            delete body.reasoning_format
            response = await postChatCompletion(base, apiKey, body)
          }
        }
        if (!response.ok) {
          lastError = await readError(response)
          if (asJson) {
            continue
          }
          if (!isRetryableModelError(lastError)) {
            throw new Error(lastError)
          }
          break
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const content = data.choices?.[0]?.message?.content?.trim() ?? ''
        if (content) {
          return content
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (asJson) {
          continue
        }
        if (!isRetryableModelError(lastError)) {
          throw error
        }
        break
      }
    }
  }
  throw new Error(lastError)
}

async function geminiGenerate(
  apiKey: string,
  blob: Blob | undefined,
  prompt: string,
  options?: { imageDataUrl?: string; json?: boolean },
): Promise<string> {
  const models = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-flash-latest',
  ]
  const parts: Array<Record<string, unknown>> = [{ text: prompt }]
  if (blob) {
    parts.push({
      inlineData: {
        mimeType: blob.type.includes('wav') ? 'audio/wav' : blob.type || 'audio/wav',
        data: await blobToBase64(blob),
      },
    })
  }
  const image = parseDataUrl(options?.imageDataUrl)
  if (image) {
    parts.push({
      inlineData: {
        mimeType: image.mime,
        data: image.data,
      },
    })
  }

  let lastError = 'Gemini request failed'
  for (const model of models) {
    const thinkingModes = image ? [true, false] : [false]
    for (const withThinkingOff of thinkingModes) {
      const generationConfig: Record<string, unknown> = { temperature: image ? 0.1 : 0.2 }
      if (options?.json) {
        generationConfig.responseMimeType = 'application/json'
      }
      if (image) {
        generationConfig.maxOutputTokens = 1600
        if (withThinkingOff) {
          generationConfig.thinkingConfig = { thinkingBudget: 0 }
        }
      }
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig,
          }),
        },
      )

      if (!response.ok) {
        lastError = await readError(response)
        if (withThinkingOff && /thinking|unknown argument|invalid argument/i.test(lastError)) {
          continue
        }
        if (isRetryableModelError(lastError)) {
          break
        }
        throw new Error(lastError)
      }

      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        error?: { message?: string }
      }
      if (data.error?.message) {
        lastError = data.error.message
        if (isRetryableModelError(lastError)) {
          break
        }
        continue
      }
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('')
        .trim()
      if (text) {
        return text
      }
    }
  }

  throw new Error(lastError)
}

function parseDataUrl(dataUrl?: string): { mime: string; data: string } | null {
  if (!dataUrl) {
    return null
  }
  const match = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) {
    return null
  }
  return { mime: match[1], data: match[2] }
}

async function postChatCompletion(
  base: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function compactScreenshot(dataUrl: string): Promise<string> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') {
    return dataUrl
  }
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const maxSide = 1280
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
      if (scale >= 0.98 && dataUrl.length < 220_000) {
        resolve(dataUrl)
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.72))
    }
    image.onerror = () => resolve(dataUrl)
    image.src = dataUrl
  })
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      error?: { message?: string } | string
    }
    if (typeof data.error === 'string') {
      return data.error
    }
    return data.error?.message ?? `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

function isRetryableModelError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('model') ||
    lower.includes('does not exist') ||
    lower.includes('not found') ||
    lower.includes('not supported')
  )
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}
