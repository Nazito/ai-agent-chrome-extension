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
Return JSON only: {"questions":["..."]}
Include only questions that expect an answer from listeners or the room.
Skip rhetorical questions, check-ins ("can you hear me?", "слышно?"), tag questions ("right?", "да?"), and unfinished fragments.
Keep the speaker's original wording, lightly cleaned.
If none, return {"questions":[]}.`

const ANSWER_RU =
  'Ты помогаешь участнику созвона ответить на вопрос спикера. Короткий ответ на русском, 2–6 предложений, как реплика вслух. Опирайся на недавнюю расшифровку. Не выдумывай факты встречи, которых нет в контексте. Если из контекста нельзя ответить — дай краткий общий ответ и скажи, чего не хватает. Верни только текст ответа.'
const ANSWER_EN =
  'You help a meeting participant answer a question the speaker just asked. Write a short spoken-style answer in English, 2–6 sentences. Use the recent transcript as context. Do not invent meeting facts that are not in the context. If the transcript is not enough, give a brief general answer and say what is missing. Return only the answer.'

export async function extractQuestions(
  provider: ProviderId,
  apiKey: string,
  windowText: string,
): Promise<string[]> {
  if (!windowText.trim()) {
    return []
  }
  const raw = await chatText(provider, apiKey, windowText, EXTRACT_QUESTIONS_PROMPT)
  return parseQuestionList(raw)
}

export async function answerQuestion(
  provider: ProviderId,
  apiKey: string,
  question: string,
  context: string,
  language: 'ru' | 'en',
): Promise<string> {
  const prompt = language === 'ru' ? ANSWER_RU : ANSWER_EN
  const user = context.trim()
    ? `Question:\n${question}\n\nRecent transcript:\n${context}`
    : `Question:\n${question}`
  return chatText(provider, apiKey, user, prompt)
}

function chatText(provider: ProviderId, apiKey: string, text: string, prompt: string): Promise<string> {
  if (provider === 'groq') {
    return chatOpenAiCompatible('https://api.groq.com/openai/v1', apiKey, text, prompt, [
      'openai/gpt-oss-20b',
      'qwen/qwen3.6-27b',
      'openai/gpt-oss-120b',
    ])
  }
  if (provider === 'gemini') {
    return geminiGenerate(apiKey, undefined, `${prompt}\n\n${text}`)
  }
  return chatOpenAiCompatible('https://api.openai.com/v1', apiKey, text, prompt, ['gpt-4o-mini'])
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
    .filter((item) => item.length > 8)
}

function tryParseJson(text: string | null): { questions?: unknown } | unknown[] | null {
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
): Promise<string> {
  let lastError = 'Translation failed'
  for (const model of models) {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: text },
          ],
        }),
      })
      if (!response.ok) {
        lastError = await readError(response)
        if (!isRetryableModelError(lastError)) {
          throw new Error(lastError)
        }
        continue
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return data.choices?.[0]?.message?.content?.trim() ?? ''
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (!isRetryableModelError(lastError)) {
        throw error
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
