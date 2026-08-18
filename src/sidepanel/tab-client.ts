const CHUNK_SECONDS = 3
const SILENCE_RMS = 0.007
const METER_MS = 80
const PROCESSOR_BUFFER = 4096

export type TabAudioHandlers = {
  onLevel: (level: number, bands: number[]) => void
  onChunk: (blob: Blob, rms: number) => void
}

export class TabAudioSession {
  private captureStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private processor: ScriptProcessorNode | null = null
  private readonly preview: HTMLVideoElement
  private meterTimer = 0
  private generation = 0
  private wanted = false
  private pending: Float32Array[] = []
  private pendingSamples = 0

  constructor(private readonly handlers: TabAudioHandlers) {
    this.preview = document.createElement('video')
    this.preview.muted = true
    this.preview.playsInline = true
    this.preview.setAttribute('aria-hidden', 'true')
    this.preview.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.append(this.preview)
  }

  get active(): boolean {
    return this.wanted
  }

  async attach(stream: MediaStream): Promise<void> {
    await this.stop()
    this.wanted = true
    this.captureStream = stream
    this.pending = []
    this.pendingSamples = 0

    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      this.wanted = false
      throw new Error('NO_TAB_AUDIO')
    }
    audioTracks.forEach((track) => {
      track.enabled = true
    })
    const audioStream = new MediaStream(audioTracks)

    const videoTracks = stream.getVideoTracks()
    if (videoTracks.length > 0) {
      this.preview.srcObject = new MediaStream(videoTracks)
      await this.preview.play().catch(() => undefined)
    }

    this.audioContext = new AudioContext()
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }

    const source = this.audioContext.createMediaStreamSource(audioStream)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.smoothingTimeConstant = 0.4
    this.processor = this.audioContext.createScriptProcessor(PROCESSOR_BUFFER, 1, 1)
    const sink = this.audioContext.createGain()
    sink.gain.value = 0

    source.connect(this.analyser)
    source.connect(this.processor)
    this.processor.connect(sink)
    sink.connect(this.audioContext.destination)

    const generation = ++this.generation
    this.processor.onaudioprocess = (event) => {
      if (!this.wanted || this.generation !== generation) {
        return
      }
      this.collectPcm(event.inputBuffer.getChannelData(0))
    }

    this.meterLoop()
  }

  async stop(): Promise<void> {
    this.wanted = false
    this.generation += 1
    window.clearTimeout(this.meterTimer)
    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
    }
    this.processor = null
    this.captureStream?.getTracks().forEach((track) => track.stop())
    this.captureStream = null
    this.pending = []
    this.pendingSamples = 0
    this.preview.pause()
    this.preview.srcObject = null
    await this.audioContext?.close().catch(() => undefined)
    this.audioContext = null
    this.analyser = null
    this.handlers.onLevel(0, new Array(12).fill(0))
  }

  private collectPcm(input: Float32Array): void {
    this.pending.push(new Float32Array(input))
    this.pendingSamples += input.length
    const sampleRate = this.audioContext?.sampleRate ?? 48000
    if (this.pendingSamples < sampleRate * CHUNK_SECONDS) {
      return
    }

    const pcm = mergePcm(this.pending, this.pendingSamples)
    this.pending = []
    this.pendingSamples = 0
    const rms = pcmRms(pcm)
    if (rms < SILENCE_RMS) {
      return
    }
    this.handlers.onChunk(encodeWav(pcm, sampleRate), rms)
  }

  private meterLoop(): void {
    if (!this.analyser || !this.wanted) {
      return
    }
    const { level, bands } = readMeter(this.analyser)
    this.handlers.onLevel(level, bands)
    this.meterTimer = window.setTimeout(() => this.meterLoop(), METER_MS)
  }
}

export function pickTabAudio(): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(['tab', 'audio'], (streamId, options) => {
      if (!streamId) {
        reject(new Error(chrome.i18n.getMessage('tabPickerCancel')))
        return
      }
      if (options && !options.canRequestAudioTrack) {
        reject(new Error(chrome.i18n.getMessage('tabPickerNoAudio')))
        return
      }

      const constraints = {
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId,
          },
        },
      } as unknown as MediaStreamConstraints

      navigator.mediaDevices.getUserMedia(constraints).then(resolve).catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  })
}

function readMeter(node: AnalyserNode): { level: number; bands: number[] } {
  const time = new Uint8Array(node.fftSize)
  node.getByteTimeDomainData(time)
  let sum = 0
  for (const sample of time) {
    const centered = (sample - 128) / 128
    sum += centered * centered
  }
  const rms = Math.sqrt(sum / time.length)
  const level = Math.min(1, rms * 8)

  const freq = new Uint8Array(node.frequencyBinCount)
  node.getByteFrequencyData(freq)
  const bands = Array.from({ length: 12 }, (_, index) => {
    const start = 2 + index * 8
    const slice = freq.slice(start, start + 8)
    const peak = slice.reduce((max, value) => Math.max(max, value), 0)
    return Math.min(1, peak / 90)
  })

  return { level, bands }
}

function mergePcm(parts: Float32Array[], total: number): Float32Array {
  const pcm = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    pcm.set(part, offset)
    offset += part.length
  }
  return pcm
}

function pcmRms(pcm: Float32Array): number {
  let sum = 0
  for (const sample of pcm) {
    sum += sample * sample
  }
  return Math.sqrt(sum / pcm.length)
}

function encodeWav(pcm: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(bytes)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, pcm.length * 2, true)

  let offset = 44
  for (const sample of pcm) {
    const clipped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true)
    offset += 2
  }

  return new Blob([bytes], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}
