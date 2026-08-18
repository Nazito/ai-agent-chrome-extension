export const MessageType = {
  EnsureOffscreen: 'ENSURE_OFFSCREEN',
  StartTabCapture: 'START_TAB_CAPTURE',
  StopTabCapture: 'STOP_TAB_CAPTURE',
  OffscreenStartTab: 'OFFSCREEN_START_TAB',
  OffscreenStopTab: 'OFFSCREEN_STOP_TAB',
  TabCaptureStarted: 'TAB_CAPTURE_STARTED',
  TabCaptureStopped: 'TAB_CAPTURE_STOPPED',
  TabCaptureError: 'TAB_CAPTURE_ERROR',
  TabVolume: 'TAB_VOLUME',
  TabAudioChunk: 'TAB_AUDIO_CHUNK',
  EnableOverlay: 'ENABLE_OVERLAY',
  DisableOverlay: 'DISABLE_OVERLAY',
  ShowOverlayCaption: 'SHOW_OVERLAY_CAPTION',
  ClearOverlayCaption: 'CLEAR_OVERLAY_CAPTION',
  OpenCaptionWindow: 'OPEN_CAPTION_WINDOW',
  CloseCaptionWindow: 'CLOSE_CAPTION_WINDOW',
  OverlayStatus: 'OVERLAY_STATUS',
  OverlayPlaqueCount: 'OVERLAY_PLAQUE_COUNT',
  RequestPlaqueCount: 'REQUEST_PLAQUE_COUNT',
  SetTranslateDirection: 'SET_TRANSLATE_DIRECTION',
} as const

export type CaptureSource = 'tab' | 'desktop'

export type ExtensionMessage =
  | { type: typeof MessageType.EnsureOffscreen }
  | { type: typeof MessageType.StartTabCapture; streamId: string; source: CaptureSource }
  | { type: typeof MessageType.StopTabCapture }
  | { type: typeof MessageType.OffscreenStartTab; streamId: string; source: CaptureSource }
  | { type: typeof MessageType.OffscreenStopTab }
  | { type: typeof MessageType.TabCaptureStarted }
  | { type: typeof MessageType.TabCaptureStopped }
  | { type: typeof MessageType.TabCaptureError; error: string }
  | { type: typeof MessageType.TabVolume; level: number; bands: number[] }
  | {
      type: typeof MessageType.TabAudioChunk
      buffer: ArrayBuffer
      mimeType: string
      rms: number
    }
  | { type: typeof MessageType.EnableOverlay; direction?: 'en-ru' | 'ru-en' }
  | { type: typeof MessageType.DisableOverlay }
  | { type: typeof MessageType.ShowOverlayCaption; original: string; translation: string }
  | { type: typeof MessageType.ClearOverlayCaption; target?: 'original' | 'translation' }
  | { type: typeof MessageType.OpenCaptionWindow; direction?: 'en-ru' | 'ru-en' }
  | { type: typeof MessageType.CloseCaptionWindow }
  | { type: typeof MessageType.OverlayStatus; original: boolean; translation: boolean }
  | { type: typeof MessageType.OverlayPlaqueCount; count: number }
  | { type: typeof MessageType.RequestPlaqueCount }
  | { type: typeof MessageType.SetTranslateDirection; direction: 'en-ru' | 'ru-en' }

export type CommandResponse = { ok: true } | { ok: false; error?: string; code?: string }
