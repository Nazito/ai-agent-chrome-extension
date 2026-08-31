import { type ProviderId, type TranslateDirection } from './storage.js'

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

const ANSWER_PROMPT = `You help a meeting participant give a spoken answer.
Return JSON only: {"en":"...","ru":"..."}
No markdown, no XML, no HTML, no thinking, no tags.
Each value is one short spoken sentence, 6–14 words.
No greeting, no second sentence, no lists, no quotes around the sentence.
Use the transcript. Do not invent meeting facts.
If the transcript is not enough, say that in one short sentence.`

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
  context: string,
): Promise<{ en: string; ru: string }> {
  const recent = context.trim().split(/\n+/).slice(-10).join('\n')
  const user = recent
    ? `Question:\n${question}\n\nRecent transcript:\n${recent}`
    : `Question:\n${question}`
  const raw = await chatText(provider, apiKey, user, ANSWER_PROMPT, true)
  return parseAnswerPair(raw)
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
  const sentence = (clean.match(/.*?[.!?…]+(?:\s|$)/u)?.[0] ?? clean).trim()
  const words = sentence.split(/\s+/).filter(Boolean)
  if (words.length > 16) {
    return `${words.slice(0, 16).join(' ')}.`
  }
  return sentence
}

function tryParseJson(text: string | null): { questions?: unknown; en?: unknown; ru?: unknown } | unknown[] | null {
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text) as { questions?: unknown } | unknown[]
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
): Promise<string> {
  let lastError = 'Translation failed'
  for (const model of models) {
    const modes = json ? [true, false] : [false]
    for (const asJson of modes) {
      try {
        const body: Record<string, unknown> = {
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: text },
          ],
        }
        if (asJson) {
          body.response_format = { type: 'json_object' }
        }
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
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

async function geminiGenerate(apiKey: string, blob: Blob | undefined, prompt: string): Promise<string> {
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
  const parts: Array<Record<string, unknown>> = [{ text: prompt }]
  if (blob) {
    parts.push({
      inlineData: {
        mimeType: blob.type.includes('wav') ? 'audio/wav' : blob.type || 'audio/wav',
        data: await blobToBase64(blob),
      },
    })
  }

  let lastError = 'Gemini request failed'
  for (const model of models) {
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
          generationConfig: { temperature: 0.2 },
        }),
      },
    )

    if (!response.ok) {
      lastError = await readError(response)
      if (isRetryableModelError(lastError)) {
        continue
      }
      throw new Error(lastError)
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      error?: { message?: string }
    }
    if (data.error?.message) {
      lastError = data.error.message
      continue
    }
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim()
    return text
  }

  throw new Error(lastError)
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
