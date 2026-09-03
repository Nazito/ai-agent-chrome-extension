class JarvisPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.parts = []
    this.samples = 0
    this.target = 4096
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel || channel.length === 0) {
      return true
    }
    this.parts.push(Float32Array.from(channel))
    this.samples += channel.length
    if (this.samples >= this.target) {
      const merged = new Float32Array(this.samples)
      let offset = 0
      for (const part of this.parts) {
        merged.set(part, offset)
        offset += part.length
      }
      this.port.postMessage(merged)
      this.parts = []
      this.samples = 0
    }
    return true
  }
}

registerProcessor('jarvis-pcm', JarvisPcmProcessor)
