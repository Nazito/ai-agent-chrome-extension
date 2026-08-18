export type ApiFailureKind = 'badKey' | 'quota' | 'rateLimit' | 'modelGone' | 'network' | 'unknown'

export class NamedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'NamedError'
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function classifyApiError(error: unknown): ApiFailureKind {
  const text = errorText(error).toLowerCase()
  if (
    text.includes('incorrect api key') ||
    text.includes('invalid api key') ||
    text.includes('invalid_api_key') ||
    text.includes('unauthorized') ||
    text.includes('authentication') ||
    text.includes('api key not valid') ||
    text.includes('api_key_invalid') ||
    /\b401\b/.test(text)
  ) {
    return 'badKey'
  }
  if (
    text.includes('insufficient_quota') ||
    text.includes('exceeded your current quota') ||
    text.includes('billing') ||
    text.includes('quota exceeded')
  ) {
    return 'quota'
  }
  if (text.includes('rate limit') || text.includes('too many') || /\b429\b/.test(text)) {
    return 'rateLimit'
  }
  if (
    text.includes('does not exist') ||
    text.includes('do not have access') ||
    text.includes('model_not_found') ||
    text.includes('model not found') ||
    text.includes('deprecat')
  ) {
    return 'modelGone'
  }
  if (
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('network error') ||
    text.includes('load failed') ||
    text.includes('offline')
  ) {
    return 'network'
  }
  return 'unknown'
}

export function overlayIssueKey(error: unknown): string {
  if (error instanceof NamedError) {
    if (error.code === 'overlay-incognito') {
      return 'issueOverlayIncognito'
    }
    if (error.code === 'overlay-no-tab') {
      return 'issueOverlayNoTab'
    }
    if (error.code === 'overlay-denied') {
      return 'issueOverlayDenied'
    }
    if (error.code === 'overlay-host') {
      return 'issueOverlayHost'
    }
  }
  const text = errorText(error).toLowerCase()
  if (text.includes('incognito') || text.includes('инкогнито')) {
    return 'issueOverlayIncognito'
  }
  if (text.includes('https-вкладк') || text.includes('regular https')) {
    return 'issueOverlayNoTab'
  }
  if (
    text.includes('cannot access contents') ||
    text.includes('respective host') ||
    text.includes('site access') ||
    text.includes('доступ к сайтам')
  ) {
    return 'issueOverlayHost'
  }
  return 'issueOverlayUnknown'
}
