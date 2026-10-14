import {
  makeChirpTrain,
  measureLatency,
  stats,
  rmsDb,
  detectOnsets,
  offsetsFromBeats,
  encodeWav,
} from './detect.js'

const $ = (id) => document.getElementById(id)
const fmt = (n, d = 0) => (n == null || !Number.isFinite(n) ? '–' : n.toFixed(d))

// 60 BPM: claps can be measured for delays up to 850 ms without a
// measured delay to anchor to (Bluetooth on Android reached ~660 ms).
const BPM = 60
const BEATS = 24
const MAX_LATENCY_MS = 900
const BLUETOOTH_MIC = /bluetooth|airpods|headset|hands-?free|buds|\bbt\b/i
// Declared before `state`, which loads the saved log as the module starts.
const LOG_KEY = 'overdub-lab-log-v1'

const state = {
  ctx: null,
  stream: null,
  source: null,
  capture: null,
  sink: null,
  lastLoopbackMs: null,
  base: null, // AudioBuffer
  baseIsDrums: true,
  take: null, // { samples, rel } rel = take start minus base start, in frames
  takeNumber: 0,
  ratings: new Map(), // "take|correction" → index in log, so re-rating updates the row
  log: loadLog(),
}

// ── Audio setup ──────────────────────────────────────────────────────────────

async function startAudio() {
  if (!requireDevice()) return
  setStatus('setup-status', 'Starting…')
  await stopAudio()
  try {
    const echoCancellation = $('ec').checked
    const deviceId = $('mic').value
    const audio = { echoCancellation, noiseSuppression: echoCancellation, autoGainControl: echoCancellation }
    if (deviceId) audio.deviceId = { exact: deviceId }

    // Ask Safari for a record-and-play audio session (no-op elsewhere).
    if (navigator.audioSession) {
      try { navigator.audioSession.type = 'play-and-record' } catch {}
    }

    // Mic first, then the context, so the context opens at the rate the mic
    // runs at (iOS and Firefox misbehave when they differ).
    const stream = await navigator.mediaDevices.getUserMedia({ audio })
    const track = stream.getAudioTracks()[0]
    const rate = track.getSettings().sampleRate
    let ctx
    try {
      ctx = new AudioContext(rate ? { sampleRate: rate, latencyHint: 'interactive' } : { latencyHint: 'interactive' })
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' })
    }
    await ctx.audioWorklet.addModule('capture-worklet.js')
    await ctx.resume()

    const source = ctx.createMediaStreamSource(stream)
    const capture = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
    const sink = ctx.createGain()
    sink.gain.value = 0 // keep the worklet pulled without hearing the mic
    source.connect(capture).connect(sink).connect(ctx.destination)

    Object.assign(state, { ctx, stream, source, capture, sink })
    await listMics()
    renderInfo()
    setStatus('setup-status', 'Ready. Run Test A, then Test B.', 'ok')
    document.body.classList.add('ready')
  } catch (err) {
    setStatus('setup-status', `Couldn't start audio: ${err.message || err.name}`, 'bad')
  }
}

async function stopAudio() {
  state.stream?.getTracks().forEach((t) => t.stop())
  if (state.ctx) await state.ctx.close().catch(() => {})
  Object.assign(state, { ctx: null, stream: null, source: null, capture: null, sink: null })
  document.body.classList.remove('ready')
}

async function listMics() {
  const select = $('mic')
  const current = state.stream?.getAudioTracks()[0]?.getSettings().deviceId ?? select.value
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  select.innerHTML = '<option value="">Default mic</option>' +
    devices.map((d) => `<option value="${d.deviceId}">${escapeHtml(d.label || 'Microphone')}</option>`).join('')
  if (devices.some((d) => d.deviceId === current)) select.value = current
}

function micLabel() {
  return state.stream?.getAudioTracks()[0]?.label || '–'
}

// What the browser says the delay is. Compared against the measurement to
// see whether the app could trust it instead of calibrating.
function reportedLatencyMs() {
  const ctx = state.ctx
  if (!ctx) return null
  const out = (ctx.baseLatency || 0) + (ctx.outputLatency || 0)
  const input = state.stream?.getAudioTracks()[0]?.getSettings().latency || 0
  return (out + input) * 1000
}

function renderInfo() {
  const ctx = state.ctx
  const settings = state.stream?.getAudioTracks()[0]?.getSettings() ?? {}
  const label = micLabel()
  $('info').innerHTML = `
    <dt>Browser</dt><dd>${escapeHtml(browserName())}</dd>
    <dt>Mic in use</dt><dd>${escapeHtml(label)}</dd>
    <dt>Echo cancellation</dt><dd>${settings.echoCancellation ? 'on' : 'off'}</dd>
    <dt>Sample rate</dt><dd>${ctx.sampleRate} Hz</dd>
    <dt>Browser-reported delay</dt><dd>${fmt(reportedLatencyMs())} ms
      <small>(output ${fmt(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000)} + input ${fmt((settings.latency || 0) * 1000)})</small></dd>
    <dt>Audio session</dt><dd>${navigator.audioSession ? navigator.audioSession.type : 'not available'}</dd>`
  $('bt-mic-warning').hidden = !BLUETOOTH_MIC.test(label)
}

// ── Recording on the playback clock ─────────────────────────────────────────

function startCapture() {
  const chunks = []
  let resolveStop
  const stopped = new Promise((r) => { resolveStop = r })
  state.capture.port.onmessage = (e) => {
    if (e.data.type === 'data') chunks.push(e.data)
    else if (e.data.type === 'stopped') resolveStop()
  }
  state.capture.port.postMessage('start')
  return async function stop() {
    state.capture.port.postMessage('stop')
    await stopped
    if (!chunks.length) throw new Error('No audio captured')
    const startFrame = chunks[0].frame
    const end = chunks.at(-1).frame + chunks.at(-1).samples.length
    const samples = new Float32Array(end - startFrame)
    for (const c of chunks) samples.set(c.samples, c.frame - startFrame)
    return { samples, startFrame }
  }
}

// The app records with MediaRecorder today. Run one alongside to compare how
// steady its timing is. Its start time is only known from the 'start' event.
function startMediaRecorder() {
  if (!window.MediaRecorder) return null
  const chunks = []
  const rec = new MediaRecorder(state.stream)
  let startTime = null
  rec.onstart = () => { startTime = state.ctx.currentTime }
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const done = new Promise((r) => { rec.onstop = r })
  rec.start()
  return async function stop() {
    rec.stop()
    await done
    const blob = new Blob(chunks, { type: rec.mimeType })
    const buffer = await state.ctx.decodeAudioData(await blob.arrayBuffer())
    return { samples: buffer.getChannelData(0), startTime }
  }
}

function playBuffer(samples, when) {
  const buffer = state.ctx.createBuffer(1, samples.length, state.ctx.sampleRate)
  buffer.copyToChannel(samples, 0)
  const node = state.ctx.createBufferSource()
  node.buffer = buffer
  node.connect(state.ctx.destination)
  node.start(when)
  return node
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Test A: automatic delay meter ───────────────────────────────────────────

async function runLoopback() {
  if (!requireDevice()) return
  const ctx = state.ctx
  await ctx.resume()
  const sr = ctx.sampleRate
  const btn = $('run-a')
  btn.disabled = true
  setStatus('a-status', 'Playing 8 chirps… keep still and quiet.')

  try {
    const train = makeChirpTrain(sr, { count: 8, intervalMs: 1000, tailMs: MAX_LATENCY_MS + 200 })
    const stopCapture = startCapture()
    const stopMr = $('compare-mr').checked ? startMediaRecorder() : null
    await sleep(400)
    const t0 = ctx.currentTime + 0.3
    playBuffer(train.buffer, t0)
    const sentFrames = train.offsets.map((o) => Math.round(t0 * sr) + o)
    await sleep(((t0 - ctx.currentTime) * 1000) + (train.buffer.length / sr) * 1000 + 200)

    const { samples, startFrame } = await stopCapture()
    setStatus('a-status', 'Analysing…')
    await sleep(30)
    const expected = sentFrames.map((f) => f - startFrame)
    const results = measureLatency(samples, train.chirp, expected, sr, { maxLatencyMs: MAX_LATENCY_MS })
    const found = results.filter((r) => r.found)
    const s = stats(found.map((r) => r.latencyMs))
    const levels = stats(found.map((r) => r.levelDb))
    const noiseDb = rmsDb(samples, 0, expected[0])

    let mr = null
    if (stopMr) {
      try {
        const out = await stopMr()
        if (out.startTime != null) {
          const mrExpected = sentFrames.map((f) => f - Math.round(out.startTime * sr))
          // Its start time is a guess from the 'start' event, so allow early hits.
          const mrFound = measureLatency(out.samples, train.chirp, mrExpected, sr, { minLatencyMs: -100, maxLatencyMs: MAX_LATENCY_MS - 50 })
            .filter((r) => r.found)
          mr = stats(mrFound.map((r) => r.latencyMs))
        }
      } catch (err) {
        mr = { error: err.message }
      }
    }

    if (s) state.lastLoopbackMs = s.median
    renderLoopback(results, s, levels, noiseDb, mr)
    addLog({
      test: 'A loopback',
      found: `${found.length}/8`,
      delayMs: s ? fmt(s.median, 1) : '',
      jitterMs: s ? fmt(s.sd, 1) : '',
      rangeMs: s ? `${fmt(s.min)}–${fmt(s.max)}` : '',
      chirpDb: levels ? fmt(levels.median, 0) : '',
      noiseDb: fmt(noiseDb, 0),
      reportedMs: fmt(reportedLatencyMs(), 0),
      mediaRecorder: mr && !mr.error ? fmt(mr.median, 1) : mr?.error ? 'error' : '',
      mrGapMs: mr && !mr.error && s ? mrGap(mr, s) : '',
    })
    setStatus('a-status', found.length
      ? `Done. Heard ${found.length} of 8 chirps.`
      : silentWarning(samples) || 'No chirps heard. Turn the volume up; with headphones, hold an earbud right against the mic.', found.length ? 'ok' : '')
  } catch (err) {
    setStatus('a-status', `Test failed: ${err.message}`, 'bad')
  } finally {
    btn.disabled = false
  }
}

function mrGap(mr, s) {
  const d = mr.median - s.median
  return `${d >= 0 ? '+' : ''}${fmt(d, 1)} ms`
}

function renderLoopback(results, s, levels, noiseDb, mr) {
  const rows = results.map((r, i) => `<tr><td>${i + 1}</td><td>${r.found ? fmt(r.latencyMs, 1) + ' ms' : 'not heard'}</td>
    <td>${fmt(r.score, 2)}</td><td>${r.found ? fmt(r.levelDb, 0) + ' dB' : '–'}</td></tr>`).join('')
  $('a-result').innerHTML = `
    <div class="big">${s ? `${fmt(s.median, 1)} ms` : 'not heard'}</div>
    <div class="sub">${s
      ? `Delay (median). Varies by ±${fmt(s.sd, 1)} ms (range ${fmt(s.min, 1)}–${fmt(s.max, 1)}).`
      : 'Nothing from the playback reached the mic.'}</div>
    <dl class="kv">
      <dt>Chirp level in the recording</dt><dd>${levels ? fmt(levels.median, 0) + ' dBFS' : '–'}</dd>
      <dt>Background noise</dt><dd>${Number.isFinite(noiseDb) ? fmt(noiseDb, 0) + ' dBFS' : 'silent'}</dd>
      <dt>Browser-reported delay</dt><dd>${fmt(reportedLatencyMs(), 0)} ms</dd>
      ${mr ? `<dt>Same test via MediaRecorder</dt><dd>${mr.error ? 'failed: ' + escapeHtml(mr.error) : `${fmt(mr.median, 1)} ms${s ? ` (${mrGap(mr, s)} vs same-clock; this gap changing between runs = timing the app can't predict)` : ''}`}</dd>` : ''}
    </dl>
    <details><summary>Each chirp</summary>
      <table><thead><tr><th>#</th><th>Delay</th><th>Match</th><th>Level</th></tr></thead><tbody>${rows}</tbody></table>
    </details>`
}

// ── Test B: musician test ───────────────────────────────────────────────────

function makeDrumLoop(sr) {
  const beat = Math.round((60 / BPM) * sr)
  const out = new Float32Array(beat * BEATS + sr)
  let seed = 1
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  const add = (at, len, fn) => { for (let i = 0; i < len && at + i < out.length; i++) out[at + i] += fn(i / sr) }
  for (let b = 0; b < BEATS; b++) {
    const at = b * beat
    if (b % 4 === 0 || b % 4 === 2) add(at, sr * 0.3, (t) => 0.9 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9))
    if (b % 4 === 1 || b % 4 === 3) add(at, sr * 0.2, (t) => 0.45 * noise() * Math.exp(-t * 25))
    for (const half of [0, beat / 2]) add(at + Math.round(half), sr * 0.05, (t) => 0.12 * noise() * Math.exp(-t * 80))
  }
  return out
}

function getBase() {
  if (!state.base || state.base.sampleRate !== state.ctx.sampleRate) {
    const samples = makeDrumLoop(state.ctx.sampleRate)
    state.base = toBuffer(samples)
    state.baseIsDrums = true
  }
  return state.base
}

function toBuffer(samples) {
  const buffer = state.ctx.createBuffer(1, samples.length, state.ctx.sampleRate)
  buffer.copyToChannel(samples, 0)
  return buffer
}

async function loadBaseFile(file) {
  try {
    const decoded = await state.ctx.decodeAudioData(await file.arrayBuffer())
    state.base = decoded
    state.baseIsDrums = false
    setStatus('b-status', `Using "${file.name}" as the base (${fmt(decoded.duration, 1)} s). Clap timing is only measured on the built-in drum loop.`, 'ok')
  } catch {
    setStatus('b-status', "Couldn't read that file.", 'bad')
  }
}

let recordingB = null

async function recordTake() {
  if (!requireDevice()) return
  const ctx = state.ctx
  await ctx.resume()
  const sr = ctx.sampleRate
  const base = getBase()
  $('record-b').disabled = true
  stopPlayback()

  const stopCapture = startCapture()
  await sleep(300)
  const t0 = ctx.currentTime + 0.3
  const node = ctx.createBufferSource()
  node.buffer = base
  node.connect(ctx.destination)
  node.start(t0)
  recordingB = node
  const total = base.duration * 1000 + 600
  const started = performance.now()
  const timer = setInterval(() => {
    const left = Math.max(0, (total - (performance.now() - started)) / 1000)
    setStatus('b-status', `Recording… ${state.baseIsDrums ? 'clap on every beat' : 'play along'}. ${fmt(left)} s left.`)
  }, 250)

  await sleep(((t0 - ctx.currentTime) * 1000) + total)
  clearInterval(timer)
  recordingB = null
  const { samples, startFrame } = await stopCapture()
  const rel = startFrame - Math.round(t0 * sr) // take start relative to base start (negative)
  state.take = { samples, rel }
  state.takeNumber += 1
  markVerdict(null)
  $('record-b').disabled = false

  let clapMs = null
  if (state.baseIsDrums) {
    const onsets = detectOnsets(samples, sr).map((f) => f + rel)
    // Centre on Test A's delay when there is one, so long delays can't wrap.
    const centerMs = state.lastLoopbackMs ?? undefined
    const offsets = offsetsFromBeats(onsets, Math.round((60 / BPM) * sr), sr, { firstBeat: 1, lastBeat: BEATS - 1, centerMs })
    const s = stats(offsets)
    if (s && s.n >= 8) clapMs = s.median
    $('b-claps').textContent = s && s.n >= 8
      ? `Your claps landed ${fmt(s.median)} ms after the beat (median of ${s.n}, spread ±${fmt(s.sd)} ms). That's the device delay plus your own timing.`
      : `Only ${s?.n ?? 0} claps detected. Clap louder, on every beat, to measure delay this way.`
    if ($('output').value.includes('speaker')) {
      $('b-claps').textContent += ' On the speaker the drums are recorded too, so this mostly measures the device delay.'
    }
  } else {
    $('b-claps').textContent = ''
  }
  state.clapMs = clapMs
  renderCorrections()
  const silent = silentWarning(samples)
  setStatus('b-status', silent || `Take ${state.takeNumber} recorded. Play it back below.`, silent ? 'bad' : 'ok')
  document.body.classList.add('has-take')
}

function renderCorrections() {
  const opts = [
    ['none', 'No correction', 0],
    ['loopback', `Test A measurement (${state.lastLoopbackMs != null ? fmt(state.lastLoopbackMs, 0) + ' ms' : 'run Test A first'})`, state.lastLoopbackMs],
    ['claps', `Clap measurement (${state.clapMs != null ? fmt(state.clapMs, 0) + ' ms' : 'n/a'})`, state.clapMs],
    ['reported', `Browser-reported (${fmt(reportedLatencyMs(), 0)} ms)`, reportedLatencyMs()],
    ['manual', 'Manual', null],
  ]
  const current = $('correction').value || (state.lastLoopbackMs != null ? 'loopback' : 'none')
  $('correction').innerHTML = opts.map(([v, label, ms]) =>
    `<option value="${v}" ${ms == null && v !== 'manual' ? 'disabled' : ''}>${label}</option>`).join('')
  $('correction').value = current
  if ($('correction').selectedOptions[0]?.disabled) $('correction').value = 'none'
  syncManual()
}

function correctionMs() {
  switch ($('correction').value) {
    case 'loopback': return state.lastLoopbackMs ?? 0
    case 'claps': return state.clapMs ?? 0
    case 'reported': return reportedLatencyMs() ?? 0
    case 'manual': return Number($('manual-ms').value) || 0
    default: return 0
  }
}

function syncManual() {
  $('manual-ms').hidden = $('correction').value !== 'manual'
}

let playing = []

function stopPlayback() {
  playing.forEach((n) => { try { n.stop() } catch {} })
  playing = []
}

// Base at T; the take shifted earlier by the chosen correction.
function playMix({ withBase = true } = {}) {
  if (!state.take) return
  stopPlayback()
  const ctx = state.ctx
  const sr = ctx.sampleRate
  const T = ctx.currentTime + 0.15
  const offsetSec = state.take.rel / sr - correctionMs() / 1000

  if (withBase) {
    const b = ctx.createBufferSource()
    b.buffer = getBase()
    b.connect(ctx.destination)
    b.start(T)
    playing.push(b)
  }
  const gain = ctx.createGain()
  gain.gain.value = Number($('take-gain').value)
  const t = ctx.createBufferSource()
  t.buffer = toBuffer(state.take.samples)
  t.connect(gain).connect(ctx.destination)
  if (offsetSec >= 0) t.start(T + offsetSec)
  else t.start(T, -offsetSec)
  playing.push(t)
}

function mixdown() {
  const sr = state.ctx.sampleRate
  const base = getBase()
  const baseData = new Float32Array(base.length)
  for (let c = 0; c < base.numberOfChannels; c++) {
    const ch = base.getChannelData(c)
    for (let i = 0; i < ch.length; i++) baseData[i] += ch[i] / base.numberOfChannels
  }
  const shift = Math.round(state.take.rel - (correctionMs() / 1000) * sr)
  const gain = Number($('take-gain').value)
  const out = new Float32Array(Math.max(baseData.length, state.take.samples.length + shift))
  out.set(baseData)
  state.take.samples.forEach((s, i) => {
    const at = i + shift
    if (at >= 0 && at < out.length) out[at] += s * gain
  })
  return out
}

// One rating per take and correction: tapping again changes it instead of
// adding another row.
function rateTake(verdict) {
  if (!state.take) return
  const correction = `${$('correction').selectedOptions[0].textContent.split(' (')[0]} (${fmt(correctionMs(), 0)} ms)`
  const key = `${state.takeNumber}|${correction}`
  const existing = state.ratings.get(key)
  if (existing != null && state.log[existing]) {
    state.log[existing].verdict = verdict
    saveLog()
    renderLog()
    setStatus('b-status', `Changed take ${state.takeNumber} with ${correction} to "${verdict}".`, 'ok')
  } else {
    addLog({
      test: 'B musician',
      take: `Take ${state.takeNumber}`,
      correction,
      clapsMs: state.clapMs != null ? fmt(state.clapMs, 0) : '',
      verdict,
    })
    state.ratings.set(key, state.log.length - 1)
    setStatus('b-status', `Saved take ${state.takeNumber} with ${correction}: "${verdict}". Try another correction, or record a new take.`, 'ok')
  }
  markVerdict(verdict)
}

function markVerdict(verdict) {
  document.querySelectorAll('[data-verdict]').forEach((b) => {
    const on = b.dataset.verdict === verdict
    b.classList.toggle('chosen', on)
    b.setAttribute('aria-pressed', on ? 'true' : 'false')
  })
}

// The Xiaomi test once recorded pure digital silence; say so instead of
// reporting "nothing heard".
function silentWarning(samples) {
  return rmsDb(samples) < -100
    ? "The mic recorded complete silence. Check the mic isn't muted or taken by another app, pick the built-in mic above, then press Start audio again."
    : ''
}

// ── Results log ─────────────────────────────────────────────────────────────

function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY)) || [] } catch { return [] }
}

function saveLog() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(state.log)) } catch {}
}

function addLog(row) {
  state.log.push({
    time: new Date().toLocaleString(),
    device: $('device').value.trim() || '(unnamed)',
    detected: detected.summary,
    browser: browserName(),
    output: $('output').value,
    mic: micLabel(),
    echoCancel: state.stream?.getAudioTracks()[0]?.getSettings().echoCancellation ? 'on' : 'off',
    ...row,
  })
  saveLog()
  renderLog()
}

const LOG_COLUMNS = [
  ['time', 'Time'], ['device', 'Device'], ['detected', 'Detected'], ['browser', 'Browser'], ['output', 'Output'], ['mic', 'Mic'],
  ['echoCancel', 'Echo canc.'], ['test', 'Test'], ['take', 'Take'], ['found', 'Heard'], ['delayMs', 'Delay ms'],
  ['jitterMs', '± ms'], ['rangeMs', 'Range ms'], ['chirpDb', 'Chirp dB'], ['noiseDb', 'Noise dB'],
  ['reportedMs', 'Reported ms'], ['mediaRecorder', 'MediaRecorder ms'], ['mrGapMs', 'MR gap'], ['correction', 'Correction'],
  ['clapsMs', 'Claps ms'], ['verdict', 'Verdict'],
]

function renderLog() {
  if (!state.log.length) {
    $('log').innerHTML = '<p class="muted">No results yet.</p>'
    return
  }
  $('log').innerHTML = `<div class="scroll"><table><thead><tr>${LOG_COLUMNS.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${state.log.slice().reverse().map((r) => `<tr>${LOG_COLUMNS.map(([k]) => `<td>${escapeHtml(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

function logAsText(sep) {
  const cell = (v) => {
    const s = String(v ?? '')
    return sep === ',' && /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s.replace(/\t/g, ' ')
  }
  return [LOG_COLUMNS.map(([, h]) => h).join(sep), ...state.log.map((r) => LOG_COLUMNS.map(([k]) => cell(r[k])).join(sep))].join('\n')
}

// ── Device detection ────────────────────────────────────────────────────────
// Browsers hide the exact model for privacy. Chrome on Android usually still
// reports it (via client hints); iPhone, iPad and Mac only give the family,
// OS version and screen size. Whatever is found is saved in every result row
// ("Detected"), and an exact model pre-fills "This device".
const detected = { model: '', summary: '' }

async function detectDevice() {
  const ua = navigator.userAgent
  let family = /iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1 ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
    : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux' : 'Unknown'
  let os = ''
  const ios = ua.match(/OS (\d+)[_.](\d+)/)
  if ((family === 'iPhone' || family === 'iPad') && ios) os = `iOS ${ios[1]}.${ios[2]}`
  const android = ua.match(/Android (\d+(\.\d+)?)/)
  if (family === 'Android' && android) os = `Android ${android[1]}`

  try {
    const hints = await navigator.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion'])
    if (hints?.model) detected.model = hints.model
    if (hints?.platformVersion) {
      const major = hints.platformVersion.split('.')[0]
      if (family === 'Android') os = `Android ${major}`
      if (family === 'Mac') os = `macOS ${hints.platformVersion.split('.').slice(0, 2).join('.')}`
      if (family === 'Windows') os = Number(major) >= 13 ? 'Windows 11' : 'Windows 10'
    }
  } catch {}

  const screenSize = `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 100) / 100}x`
  detected.summary = [family, detected.model, os, screenSize].filter(Boolean).join(' · ')
}

function requireDevice() {
  const input = $('device')
  const ok = input.value.trim().length > 0
  input.classList.toggle('invalid', !ok)
  const help = $('device-help')
  if (ok) {
    help.className = ''
    help.textContent = detected.summary ? `Detected: ${detected.summary}` : ''
  } else {
    help.className = 'bad'
    help.textContent = 'Enter the device (make and model) before testing, so results can be told apart.'
    input.scrollIntoView({ behavior: 'smooth', block: 'center' })
    input.focus()
  }
  return ok
}

// "overdub-lab-results-iphone-13.csv": the device name tells the recipient
// whose results they are.
function resultsFileName() {
  const device = ($('device').value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `overdub-lab-results${device ? '-' + device : ''}.csv`
}

function canShareFiles() {
  try {
    return !!navigator.canShare?.({ files: [new File([''], 'test.csv', { type: 'text/csv' })] })
  } catch {
    return false
  }
}

// Opens the device's share sheet with the results attached as a CSV file.
async function shareLog() {
  if (!state.log.length) {
    setStatus('log-status', 'No results to share yet.', 'bad')
    return
  }
  const file = new File([logAsText(',')], resultsFileName(), { type: 'text/csv' })
  const device = $('device').value.trim()
  try {
    await navigator.share({
      files: [file],
      title: 'Overdub lab results',
      text: `Overdub lab results${device ? ` from ${device}` : ''} (${state.log.length} run${state.log.length === 1 ? "" : "s"})`,
    })
    setStatus('log-status', 'Shared.', 'ok')
  } catch (err) {
    if (err.name === 'AbortError') return // closed the share sheet
    setStatus('log-status', "Couldn't share; use Download CSV instead.", 'bad')
  }
}

function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

// ── Helpers & wiring ────────────────────────────────────────────────────────

function setStatus(id, text, kind = '') {
  const el = $(id)
  el.textContent = text
  el.className = `status ${kind}`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function browserName() {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Other'
  const b = /EdgA?\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone
  return `${b} · ${os}${standalone ? ' · home-screen app' : ''}`
}

function wire() {
  if (!window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) {
    setStatus('setup-status', "This browser can't run the test (no AudioWorklet or mic access). Use a recent Chrome or Safari over https.", 'bad')
    $('start').disabled = true
  }
  try { $('device').value = localStorage.getItem('overdub-lab-device') || '' } catch {}
  $('device').addEventListener('change', () => { try { localStorage.setItem('overdub-lab-device', $('device').value) } catch {} })
  $('device').addEventListener('input', () => {
    if ($('device').classList.contains('invalid') && $('device').value.trim()) requireDevice()
  })
  detectDevice().then(() => {
    const input = $('device')
    // Pre-fill only an exact model (Android); otherwise hint at what to add.
    if (!input.value.trim() && detected.model) input.value = detected.model
    const family = detected.summary.split(' · ')[0]
    if (!detected.model && (family === 'iPhone' || family === 'iPad')) input.placeholder = `Which ${family}? e.g. ${family} 13`
    if (!detected.model && family === 'Mac') input.placeholder = 'Which Mac? e.g. MacBook Air M2'
    $('device-help').textContent = detected.summary ? `Detected: ${detected.summary}` : ''
  })

  $('start').addEventListener('click', startAudio)
  $('ec').addEventListener('change', () => state.ctx && startAudio())
  $('mic').addEventListener('change', () => state.ctx && startAudio())
  $('run-a').addEventListener('click', runLoopback)
  $('record-b').addEventListener('click', recordTake)
  $('base-file').addEventListener('change', (e) => e.target.files[0] && loadBaseFile(e.target.files[0]))
  $('use-drums').addEventListener('click', () => { state.base = null; getBase(); setStatus('b-status', 'Using the built-in drum loop.', 'ok') })
  $('play-mix').addEventListener('click', () => playMix())
  $('play-take').addEventListener('click', () => playMix({ withBase: false }))
  $('stop').addEventListener('click', stopPlayback)
  $('correction').addEventListener('change', () => {
    syncManual()
    const key = `${state.takeNumber}|${$('correction').selectedOptions[0].textContent.split(' (')[0]} (${fmt(correctionMs(), 0)} ms)`
    const idx = state.ratings.get(key)
    markVerdict(idx != null ? state.log[idx]?.verdict : null)
  })
  $('dl-take').addEventListener('click', () => state.take && download(encodeWav(state.take.samples, state.ctx.sampleRate), 'overdub-take.wav'))
  $('dl-mix').addEventListener('click', () => state.take && download(encodeWav(mixdown(), state.ctx.sampleRate), 'overdub-mix.wav'))
  document.querySelectorAll('[data-verdict]').forEach((b) => b.addEventListener('click', () => rateTake(b.dataset.verdict)))
  $('copy-log').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(logAsText('\t')); setStatus('log-status', 'Copied. Paste into a spreadsheet.', 'ok') } catch { setStatus('log-status', "Couldn't copy; use Download CSV.", 'bad') }
  })
  $('dl-log').addEventListener('click', () => download(new Blob([logAsText(',')], { type: 'text/csv' }), resultsFileName()))
  if (canShareFiles()) $('share-log').hidden = false
  $('share-log').addEventListener('click', shareLog)
  $('clear-log').addEventListener('click', () => {
    if (confirm('Clear all saved results on this device?')) { state.log = []; saveLog(); renderLog() }
  })
  navigator.mediaDevices?.addEventListener?.('devicechange', () => state.ctx && listMics().then(renderInfo))
  renderLog()
}

wire()
