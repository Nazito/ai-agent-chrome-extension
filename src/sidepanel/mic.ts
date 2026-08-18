export type MicHandlers = {
  onLevel: (level: number, bands: number[]) => void
}

export class MicrophoneSession {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private frame = 0
  private wanted = false

  constructor(private readonly handlers: MicHandlers) {}

  get active(): boolean {
    return this.wanted
  }

  async attach(stream: MediaStream): Promise<void> {
    await this.stop()
    this.wanted = true
    this.stream = stream

    this.audioContext = new AudioContext()
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }

    const source = this.audioContext.createMediaStreamSource(stream)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 64
    source.connect(this.analyser)
    this.tick()
  }

  async stop(): Promise<void> {
    this.wanted = false
    cancelAnimationFrame(this.frame)
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    await this.audioContext?.close().catch(() => undefined)
    this.audioContext = null
    this.analyser = null
    this.handlers.onLevel(0, new Array(12).fill(0))
  }

  private tick(): void {
    if (!this.analyser || !this.wanted) {
      return
    }

    const samples = new Uint8Array(this.analyser.frequencyBinCount)
    this.analyser.getByteFrequencyData(samples)

    const bands = Array.from({ length: 12 }, (_, index) => {
      const start = 1 + index * 2
      const a = samples[start] ?? 0
      const b = samples[start + 1] ?? a
      return Math.min(1, (a + b) / 2 / 180)
    })

    const level = bands.reduce((sum, value) => sum + value, 0) / bands.length
    this.handlers.onLevel(level, bands)
    this.frame = requestAnimationFrame(() => this.tick())
  }
}

export function requestMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
  })
}
