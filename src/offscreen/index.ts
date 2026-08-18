import { type ExtensionMessage, MessageType } from '../shared/messages.js'

const CHUNK_MS = 3500
const SILENCE_RMS = 0.006
const METER_MS = 80
const playback = document.getElementById('playback') as HTMLAudioElement
const preview = document.getElementById('preview') as HTMLVideoElement

let captureStream: MediaStream | null = null
let audioStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let meterTimer = 0
let recording = false
let capturing = false
let captureGeneration = 0

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse: (value: { ok: boolean; error?: string }) => void) => {
    if (message.type === MessageType.OffscreenStartTab) {
      startCapture(message.streamId, message.source)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      return true
    }
    if (message.type === MessageType.OffscreenStopTab) {
      stopCapture()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }))
      return true
    }
    return false
  },
)

async function startCapture(streamId: string, source: 'tab' | 'desktop'): Promise<void> {
  await stopCapture(false)
  const generation = ++captureGeneration

  try {
    captureStream = await getTabMedia(streamId, source)
    const audioTracks = captureStream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('NO_TAB_AUDIO')
    }

    audioTracks.forEach((track) => {
      track.enabled = true
    })
    audioStream = new MediaStream(audioTracks)

    const videoTracks = captureStream.getVideoTracks()
    if (source === 'tab') {
      playback.srcObject = audioStream
      await playback.play()
    } else if (videoTracks.length > 0) {
      preview.srcObject = new MediaStream(videoTracks)
      preview.muted = true
      await preview.play().catch(() => undefined)
    }

    audioContext = new AudioContext()
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    const mediaSource = audioContext.createMediaStreamSource(audioStream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.4
    const sink = audioContext.createGain()
    sink.gain.value = 0
    mediaSource.connect(analyser)
    analyser.connect(sink)
    sink.connect(audioContext.destination)

    capturing = true
    recording = true
    meterLoop()
    void recordLoop(audioStream, generation)
    await send({ type: MessageType.TabCaptureStarted })
  } catch (error) {
    await stopCapture(false)
    const message = error instanceof Error ? error.message : String(error)
    await send({
      type: MessageType.TabCaptureError,
      error: message === 'NO_TAB_AUDIO' ? message : message,
    })
    throw error
  }
}

async function stopCapture(notify = true): Promise<void> {
  const wasCapturing = capturing
  capturing = false
  recording = false
  captureGeneration += 1
  window.clearTimeout(meterTimer)

  captureStream?.getTracks().forEach((track) => track.stop())
  captureStream = null
  audioStream = null
  playback.pause()
  playback.srcObject = null
  preview.pause()
  preview.srcObject = null
  await audioContext?.close().catch(() => undefined)
  audioContext = null
  analyser = null

  if (notify && wasCapturing) {
    await send({ type: MessageType.TabCaptureStopped })
  }
}

function meterLoop(): void {
  if (!analyser || !capturing) {
    return
  }

  const { level, bands, rms } = readMeter(analyser)
  void send({ type: MessageType.TabVolume, level, bands })
  meterTimer = window.setTimeout(meterLoop, METER_MS)
}

function readMeter(node: AnalyserNode): { level: number; bands: number[]; rms: number } {
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

  return { level, bands, rms }
}

async function recordLoop(stream: MediaStream, generation: number): Promise<void> {
  while (recording && captureGeneration === generation && stream.active) {
    const { blob, rms } = await recordChunk(stream, CHUNK_MS)
    if (!recording || captureGeneration !== generation) {
      break
    }
    if ((rms < SILENCE_RMS && blob.size < 1500) || blob.size < 256) {
      continue
    }
    await send({
      type: MessageType.TabAudioChunk,
      buffer: await blob.arrayBuffer(),
      mimeType: blob.type || 'audio/webm',
      rms,
    })
  }
}

function recordChunk(stream: MediaStream, durationMs: number): Promise<{ blob: Blob; rms: number }> {
  return new Promise((resolve, reject) => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks: BlobPart[] = []
    let peakRms = 0

    const rmsTimer = window.setInterval(() => {
      if (!analyser) {
        return
      }
      peakRms = Math.max(peakRms, readMeter(analyser).rms)
    }, 80)

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data)
      }
    }
    recorder.onerror = () => {
      window.clearInterval(rmsTimer)
      reject(new Error('MediaRecorder error'))
    }
    recorder.onstop = () => {
      window.clearInterval(rmsTimer)
      resolve({ blob: new Blob(chunks, { type: recorder.mimeType }), rms: peakRms })
    }

    recorder.start()
    window.setTimeout(() => {
      if (recorder.state !== 'inactive') {
        recorder.stop()
      }
    }, durationMs)
  })
}

async function send(message: ExtensionMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message)
  } catch {
    // Side panel may be closed.
  }
}

async function getTabMedia(streamId: string, source: 'tab' | 'desktop'): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(mediaConstraints(streamId, source, true))
  } catch {
    return navigator.mediaDevices.getUserMedia(mediaConstraints(streamId, source, false))
  }
}

function mediaConstraints(
  streamId: string,
  source: 'tab' | 'desktop',
  compactVideo = true,
): MediaStreamConstraints {
  const chromeMediaSource = source === 'desktop' ? 'desktop' : 'tab'
  const mandatory = {
    chromeMediaSource,
    chromeMediaSourceId: streamId,
  }

  if (source === 'desktop') {
    return {
      audio: { mandatory },
      video: {
        mandatory: compactVideo
          ? { ...mandatory, maxWidth: 16, maxHeight: 16 }
          : mandatory,
      },
    } as unknown as MediaStreamConstraints
  }

  return {
    audio: { mandatory },
    video: false,
  } as unknown as MediaStreamConstraints
}
