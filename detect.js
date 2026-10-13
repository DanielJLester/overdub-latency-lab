// Signal maths for the overdub latency lab. Pure functions, no browser APIs,
// so they can be tested outside the page.

// A short rising sweep ("chirp"). Easier to find reliably in a noisy
// recording than a plain click, and kept within 400–3200 Hz so it survives
// band-limited paths (Bluetooth headset mode, echo cancellation).
export function makeChirp(sampleRate, { f0 = 400, f1 = 3200, durationMs = 25 } = {}) {
  const n = Math.round((sampleRate * durationMs) / 1000)
  const T = n / sampleRate
  const k = f1 / f0
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const phase = ((2 * Math.PI * f0 * T) / Math.log(k)) * (Math.pow(k, t / T) - 1)
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    out[i] = Math.sin(phase) * hann
  }
  return out
}

// `count` chirps, `intervalMs` apart, followed by a silent tail.
export function makeChirpTrain(sampleRate, { count = 8, intervalMs = 1000, tailMs = 1000 } = {}) {
  const chirp = makeChirp(sampleRate)
  const interval = Math.round((sampleRate * intervalMs) / 1000)
  const length = interval * (count - 1) + chirp.length + Math.round((sampleRate * tailMs) / 1000)
  const buffer = new Float32Array(length)
  const offsets = []
  for (let c = 0; c < count; c++) {
    const at = c * interval
    offsets.push(at)
    buffer.set(chirp.map((s) => s * 0.8), at)
  }
  return { buffer, offsets, chirp }
}

function prefixSquares(signal) {
  const p = new Float64Array(signal.length + 1)
  for (let i = 0; i < signal.length; i++) p[i + 1] = p[i] + signal[i] * signal[i]
  return p
}

function dot(signal, at, template) {
  let s = 0
  for (let j = 0; j < template.length; j++) s += signal[at + j] * template[j]
  return s
}

// Finds `template` in `signal` between frames [from, to] by normalised
// cross-correlation (score 0–1, sign ignored). Coarse pass every 4 frames
// (the chirp's correlation peak is ~15 frames wide), then refined.
export function findTemplate(signal, template, from, to, squares = prefixSquares(signal)) {
  const m = template.length
  let tEnergy = 0
  for (let j = 0; j < m; j++) tEnergy += template[j] * template[j]
  const lo = Math.max(0, Math.floor(from))
  const hi = Math.min(signal.length - m, Math.floor(to))
  if (hi < lo) return null

  const scoreAt = (at) => {
    const segEnergy = squares[at + m] - squares[at]
    if (segEnergy <= 1e-12) return 0
    return Math.abs(dot(signal, at, template)) / Math.sqrt(tEnergy * segEnergy)
  }

  let best = lo
  let bestScore = -1
  for (let at = lo; at <= hi; at += 4) {
    const s = scoreAt(at)
    if (s > bestScore) { bestScore = s; best = at }
  }
  for (let at = Math.max(lo, best - 4); at <= Math.min(hi, best + 4); at++) {
    const s = scoreAt(at)
    if (s > bestScore) { bestScore = s; best = at }
  }

  let peak = 0
  for (let j = 0; j < m; j++) peak = Math.max(peak, Math.abs(signal[best + j]))
  return { frame: best, score: bestScore, levelDb: toDb(peak) }
}

export function toDb(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity
}

export function rmsDb(signal, from = 0, to = signal.length) {
  let s = 0
  const a = Math.max(0, from)
  const b = Math.min(signal.length, to)
  for (let i = a; i < b; i++) s += signal[i] * signal[i]
  return b > a ? toDb(Math.sqrt(s / (b - a))) : -Infinity
}

// Looks for each expected chirp in the recording. `expected` are the frames
// (in recording coordinates) at which each chirp was *sent*; it is searched
// for from `minLatencyMs` to `maxLatencyMs` after. Keep that window shorter
// than the gap between chirps, or a neighbouring chirp can match. Returns one
// result per chirp, with `latencyMs` set when found with at least `minScore`.
export function measureLatency(recording, template, expected, sampleRate, { minLatencyMs = -20, maxLatencyMs = 800, minScore = 0.3 } = {}) {
  const squares = prefixSquares(recording)
  const ms = (f) => (f / sampleRate) * 1000
  return expected.map((sentAt) => {
    const hit = findTemplate(
      recording,
      template,
      sentAt + (minLatencyMs * sampleRate) / 1000,
      sentAt + (maxLatencyMs * sampleRate) / 1000,
      squares
    )
    if (!hit) return { found: false, score: 0 }
    return {
      found: hit.score >= minScore,
      score: hit.score,
      levelDb: hit.levelDb,
      latencyMs: ms(hit.frame - sentAt),
    }
  })
}

export function stats(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  return { mean, sd, median, min: sorted[0], max: sorted.at(-1), n: values.length }
}

// Onsets (claps, taps, plucks) in a recording: frames where the short-term
// level jumps well above the noise floor. 120 ms refractory period.
export function detectOnsets(signal, sampleRate, { hop = 128, minDb = -45, riseRatio = 3, refractoryMs = 120 } = {}) {
  const frames = Math.floor(signal.length / hop)
  const env = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let s = 0
    for (let i = f * hop; i < (f + 1) * hop; i++) s += signal[i] * signal[i]
    env[f] = Math.sqrt(s / hop)
  }
  const sortedEnv = [...env].sort((a, b) => a - b)
  const floor = sortedEnv[Math.floor(sortedEnv.length * 0.2)] || 0
  const threshold = Math.max(floor * 6, Math.pow(10, minDb / 20))
  const refractory = Math.round((refractoryMs / 1000) * sampleRate / hop)

  const onsets = []
  let last = -Infinity
  for (let f = 2; f < frames; f++) {
    const prev = Math.max(env[f - 1], env[f - 2], 1e-9)
    if (env[f] > threshold && env[f] > prev * riseRatio && f - last >= refractory) {
      // Refine to the first sample in this hop above half the hop's peak.
      let peak = 0
      for (let i = f * hop; i < (f + 1) * hop; i++) peak = Math.max(peak, Math.abs(signal[i]))
      let at = f * hop
      while (at < (f + 1) * hop && Math.abs(signal[at]) < peak * 0.5) at++
      onsets.push(at)
      last = f
    }
  }
  return onsets
}

// How late each onset landed after the beat it belongs to. `onsets` are in
// base-clip frames (0 = base start). Each onset is matched to the beat it is
// between 150 ms before and (beat − 150 ms) after, so beats must be longer
// than the largest latency expected plus 150 ms.
export function offsetsFromBeats(onsets, beatFrames, sampleRate, { firstBeat = 0, lastBeat = Infinity } = {}) {
  const early = Math.round(0.15 * sampleRate)
  const out = []
  for (const r of onsets) {
    const k = Math.floor((r + early) / beatFrames)
    if (k < firstBeat || k > lastBeat) continue
    out.push(((r - k * beatFrames) / sampleRate) * 1000)
  }
  return out
}

// 16-bit PCM mono WAV.
export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buffer)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
