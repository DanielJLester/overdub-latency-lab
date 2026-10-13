// Records the mic inside the same AudioContext that plays the backing audio,
// so every captured sample has an exact frame number on the playback clock.
// Posts chunks of ~4096 frames: { type: 'data', frame, samples }.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false
    this.chunk = null
    this.chunkStart = 0
    this.filled = 0
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.recording = true
        this.chunk = null
      } else if (e.data === 'stop') {
        this.flush()
        this.recording = false
        this.port.postMessage({ type: 'stopped' })
      }
    }
  }

  flush() {
    if (this.chunk && this.filled) {
      this.port.postMessage({ type: 'data', frame: this.chunkStart, samples: this.chunk.subarray(0, this.filled) })
    }
    this.chunk = null
    this.filled = 0
  }

  process(inputs) {
    if (!this.recording) return true
    const channel = inputs[0] && inputs[0][0]
    const n = channel ? channel.length : 128
    if (!this.chunk) {
      this.chunk = new Float32Array(4096)
      this.chunkStart = currentFrame
      this.filled = 0
    }
    // No input yet (mic warming up) → keep the zeros so frame numbers stay exact.
    if (channel) this.chunk.set(channel, this.filled)
    this.filled += n
    if (this.filled + 128 > this.chunk.length) this.flush()
    return true
  }
}

registerProcessor('capture', CaptureProcessor)
