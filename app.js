import {
  makeChirpTrain,
  measureLatency,
  stats,
  rmsDb,
  detectOnsets,
  offsetsFromBeats,
  estimateAlignment,
} from './detect.js'

const $ = (id) => document.getElementById(id)
const fmt = (n, d = 0) => (n == null || !Number.isFinite(n) ? '' : n.toFixed(d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 60 BPM beat: claps and beeps 1 s apart, so delays up to ~850 ms read
// correctly even without a sound-check result to anchor to.
const BPM = 60
const BEATS = 24
const BEEPS = 10
const MAX_LATENCY_MS = 900
const BLUETOOTH_MIC = /bluetooth|airpods|headset|hands-?free|buds|\bbt\b/i
const LOG_KEY = 'overdub-lab-runs-v2' // declared before `state`, which loads it
const PLAY_LABEL = '<span class="ms" aria-hidden="true">play_arrow</span>Play'
const STOP_LABEL = '<span class="ms" aria-hidden="true">stop</span>Stop'

const state = {
  ctx: null,
  stream: null,
  capture: null,
  base: null, // AudioBuffer: drum beat or the tester's own track
  ownTrack: false,
  run: null, // the current test run, saved as one result row
  playing: [],
  log: loadLog(),
}

const detected = { model: '', summary: '' }

// ── Steps ────────────────────────────────────────────────────────────────────

function showStep(name) {
  document.querySelectorAll('.step').forEach((s) => { s.hidden = s.id !== `step-${name}` })
  $('intro').hidden = name !== 'setup'
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function output() {
  return document.querySelector('input[name=output]:checked').value
}

const onHeadphones = () => output() !== 'Speaker'

function newRun() {
  state.run = {
    output: output(),
    headphones: onHeadphones() ? $('headphones').value.trim() : '',
    check: null, // { ms, heard, sd }
    clap: null, // { ms, n, sd }
    take: null, // { samples, rel }
    align: null, // { ms, notes, matchRate, reliable }
  }
}

// ── Setup ───────────────────────────────────────────────────────────────────

function requireDevice() {
  const input = $('device')
  const ok = input.value.trim().length > 0
  input.classList.toggle('invalid', !ok)
  const help = $('device-help')
  help.className = ok ? 'field-help' : 'field-help bad'
  help.textContent = ok ? detectedHint() : 'Add your device so we can tell results apart.'
  if (!ok) input.focus()
  return ok
}

function detectedHint() {
  return detected.summary ? `Detected: ${detected.summary}` : ''
}

async function start() {
  if (!requireDevice()) return
  setStatus('setup-status', 'Starting…')
  try {
    await openAudio($('mic').value)
    // Headphones connected: browsers often default to the headphones' mic,
    // which lowers quality and can't hear the sound check. Prefer built-in.
    if (!$('mic').value && onHeadphones() && BLUETOOTH_MIC.test(micLabel())) {
      const builtIn = (await navigator.mediaDevices.enumerateDevices())
        .find((d) => d.kind === 'audioinput' && d.deviceId && !['default', 'communications'].includes(d.deviceId) && !BLUETOOTH_MIC.test(d.label))
      if (builtIn) await openAudio(builtIn.deviceId)
    }
    await listMics()
    $('mic-help').textContent = `Recording with: ${micLabel() || 'your default mic'}.`
    setStatus('setup-status', '')
    newRun()
    prepareCheck()
    showStep('check')
  } catch (err) {
    setStatus('setup-status', err.name === 'NotAllowedError'
      ? 'Mic access is off. Allow it in your browser settings, then press Next again.'
      : `Couldn't start audio: ${err.message || err.name}`, 'bad')
  }
}

async function openAudio(deviceId) {
  await closeAudio()
  const ec = $('ec').checked
  const audio = { echoCancellation: ec, noiseSuppression: ec, autoGainControl: ec }
  if (deviceId) audio.deviceId = { exact: deviceId }
  if (navigator.audioSession) {
    try { navigator.audioSession.type = 'play-and-record' } catch {}
  }
  // Mic first, then the context at the mic's rate (iOS/Firefox need them equal).
  const stream = await navigator.mediaDevices.getUserMedia({ audio })
  const rate = stream.getAudioTracks()[0].getSettings().sampleRate
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
  sink.gain.value = 0
  source.connect(capture).connect(sink).connect(ctx.destination)
  Object.assign(state, { ctx, stream, capture, base: state.base && state.base.sampleRate === ctx.sampleRate ? state.base : null })
}

async function closeAudio() {
  stopPlayback()
  state.stream?.getTracks().forEach((t) => t.stop())
  if (state.ctx) await state.ctx.close().catch(() => {})
  Object.assign(state, { ctx: null, stream: null, capture: null })
}

async function listMics() {
  const select = $('mic')
  const chosen = select.value
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  select.innerHTML = '<option value="">Automatic (built-in mic)</option>' +
    devices.map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || 'Microphone')}</option>`).join('')
  select.value = devices.some((d) => d.deviceId === chosen) ? chosen : ''
}

function micLabel() {
  return state.stream?.getAudioTracks()[0]?.label || ''
}

// The browser's own estimate. Logged to compare, never trusted.
function reportedLatencyMs() {
  const ctx = state.ctx
  if (!ctx) return null
  const input = state.stream?.getAudioTracks()[0]?.getSettings().latency || 0
  return ((ctx.baseLatency || 0) + (ctx.outputLatency || 0) + input) * 1000
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

function toBuffer(samples) {
  const buffer = state.ctx.createBuffer(1, samples.length, state.ctx.sampleRate)
  buffer.copyToChannel(samples, 0)
  return buffer
}

// Plays `buffer` at a scheduled time while recording; returns the recording
// and where it sits relative to the playback start (in frames, negative).
async function playAndRecord(buffer, { tailMs = 600, onTick } = {}) {
  const ctx = state.ctx
  await ctx.resume()
  const stop = startCapture()
  await sleep(300)
  const t0 = ctx.currentTime + 0.3
  const node = ctx.createBufferSource()
  node.buffer = buffer
  node.connect(ctx.destination)
  node.start(t0)
  const total = (t0 - ctx.currentTime) * 1000 + buffer.duration * 1000 + tailMs
  const started = performance.now()
  const timer = onTick && setInterval(() => onTick(Math.max(0, (total - (performance.now() - started)) / 1000)), 250)
  await sleep(total)
  if (timer) clearInterval(timer)
  const { samples, startFrame } = await stop()
  return { samples, rel: startFrame - Math.round(t0 * ctx.sampleRate), t0 }
}

function silentWarning(samples) {
  return rmsDb(samples) < -100
    ? "Your mic recorded silence. Check it isn't muted, pick another mic under Change setup › Advanced, and try again."
    : ''
}

// ── Step 2: sound check (automatic) ─────────────────────────────────────────

function prepareCheck() {
  $('check-how').textContent = onHeadphones()
    ? 'Take one earbud out and hold it against the bottom of your phone. Turn the volume up.'
    : 'Put your device down, volume up, and keep quiet for 10 seconds.'
  setStatus('check-status', '')
  $('check-next').hidden = true
  $('run-check').hidden = false
}

async function runCheck() {
  const sr = state.ctx.sampleRate
  $('run-check').disabled = true
  setStatus('check-status', 'Listening…')
  try {
    const train = makeChirpTrain(sr, { count: 8, intervalMs: 1000, tailMs: MAX_LATENCY_MS + 200 })
    const { samples, rel } = await playAndRecord(toBuffer(train.buffer), { tailMs: 0 })
    const expected = train.offsets.map((o) => o - rel)
    const found = measureLatency(samples, train.chirp, expected, sr, { maxLatencyMs: MAX_LATENCY_MS }).filter((r) => r.found)
    const s = stats(found.map((r) => r.latencyMs))
    const silent = silentWarning(samples)
    if (s && found.length >= 4) {
      state.run.check = { ms: s.median, heard: found.length, sd: s.sd }
      setStatus('check-status', `Heard it. Delay: ${fmt(s.median)} ms.`, 'ok')
    } else {
      state.run.check = { ms: null, heard: found.length, sd: null }
      setStatus('check-status', silent || "Didn't hear it clearly. That's fine, carry on.", silent ? 'bad' : '')
    }
    $('run-check').hidden = true
    $('check-next').hidden = false
  } catch (err) {
    setStatus('check-status', `Something went wrong: ${err.message}. Try again.`, 'bad')
  } finally {
    $('run-check').disabled = false
  }
}

// ── Step 3: clap along (fixed beat, no song tempo needed) ───────────────────

function prepareClap() {
  $('clap-how').textContent = onHeadphones()
    ? 'Put your headphones back on. Clap on each of the 10 beeps.'
    : 'Clap on each of the 10 beeps.'
  setStatus('clap-status', '')
  $('clap-next').hidden = true
  $('run-clap').hidden = false
  $('clap-skip').hidden = false
}

function makeBeeps(sr) {
  const beat = Math.round((60 / BPM) * sr)
  const out = new Float32Array(beat * BEEPS)
  const len = Math.round(sr * 0.06)
  for (let b = 0; b < BEEPS; b++) {
    for (let i = 0; i < len; i++) {
      const t = i / sr
      out[b * beat + i] = 0.6 * Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t * 40)
    }
  }
  return out
}

async function runClap() {
  const sr = state.ctx.sampleRate
  $('run-clap').disabled = true
  $('clap-skip').hidden = true
  try {
    const { samples, rel } = await playAndRecord(toBuffer(makeBeeps(sr)), {
      tailMs: MAX_LATENCY_MS,
      onTick: () => setStatus('clap-status', 'Clap on each beep…'),
    })
    const onsets = detectOnsets(samples, sr).map((f) => f + rel)
    // Skip the first two beeps while the tester finds the beat.
    const offsets = offsetsFromBeats(onsets, Math.round((60 / BPM) * sr), sr, {
      firstBeat: 2, lastBeat: BEEPS - 1, centerMs: state.run.check?.ms ?? undefined,
    })
    const s = stats(offsets)
    const silent = silentWarning(samples)
    if (s && s.n >= 5) {
      state.run.clap = { ms: s.median, n: s.n, sd: s.sd }
      setStatus('clap-status', `Got ${s.n} claps. Delay: ${fmt(s.median)} ms.`, 'ok')
      $('run-clap').hidden = true
      $('clap-next').hidden = false
    } else {
      setStatus('clap-status', silent || `Only heard ${s?.n ?? 0} claps. Clap a little louder and try again.`, 'bad')
      $('clap-skip').hidden = false
    }
  } catch (err) {
    setStatus('clap-status', `Something went wrong: ${err.message}. Try again.`, 'bad')
    $('clap-skip').hidden = false
  } finally {
    $('run-clap').disabled = false
  }
}

// ── Step 4: record a take ───────────────────────────────────────────────────

function makeDrumLoop(sr) {
  const beat = Math.round((60 / BPM) * sr)
  const out = new Float32Array(beat * BEATS + sr)
  let seed = 1
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  const add = (at, len, fn) => { for (let i = 0; i < len && at + i < out.length; i++) out[at + i] += fn(i / sr) }
  for (let b = 0; b < BEATS; b++) {
    const at = b * beat
    if (b % 2 === 0) add(at, sr * 0.3, (t) => 0.9 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9))
    else add(at, sr * 0.2, (t) => 0.45 * noise() * Math.exp(-t * 25))
    for (const half of [0, beat / 2]) add(at + Math.round(half), sr * 0.05, (t) => 0.12 * noise() * Math.exp(-t * 80))
  }
  return out
}

function getBase() {
  if (!state.base) {
    state.base = toBuffer(makeDrumLoop(state.ctx.sampleRate))
    state.ownTrack = false
  }
  return state.base
}

function baseMono() {
  const base = getBase()
  const out = new Float32Array(base.length)
  for (let c = 0; c < base.numberOfChannels; c++) {
    const ch = base.getChannelData(c)
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / base.numberOfChannels
  }
  return out
}

async function loadOwnTrack(file) {
  try {
    state.base = await state.ctx.decodeAudioData(await file.arrayBuffer())
    state.ownTrack = true
    $('base-status').textContent = `Using "${file.name}" (${fmt(state.base.duration)} s).`
    $('record-how').textContent = `You'll hear your track (${fmt(state.base.duration)} s). Play, sing or clap along.`
  } catch {
    $('base-status').textContent = "Couldn't read that file. Try an mp3, m4a or wav."
  }
}

async function runRecord() {
  $('run-record').disabled = true
  try {
    const base = getBase()
    const longest = Math.max(state.run.check?.ms ?? 0, state.run.clap?.ms ?? 0)
    const { samples, rel } = await playAndRecord(base, {
      // Keep recording past the end by the delay, so the last notes aren't cut.
      tailMs: Math.max(600, longest + 300),
      onTick: (left) => setStatus('record-status', `Recording… ${fmt(left)} s left`),
    })
    const silent = silentWarning(samples)
    if (silent) {
      setStatus('record-status', silent, 'bad')
      return
    }
    state.run.take = { samples, rel }
    state.run.align = estimateAlignment(baseMono(), samples, rel, state.ctx.sampleRate, { maxMs: MAX_LATENCY_MS })
    setStatus('record-status', '')
    prepareAlign()
    showStep('align')
  } catch (err) {
    setStatus('record-status', `Something went wrong: ${err.message}. Try again.`, 'bad')
  } finally {
    $('run-record').disabled = false
  }
}

// ── Step 5: line it up by ear ───────────────────────────────────────────────

function suggestions() {
  const run = state.run
  return [
    ['None', 0],
    ['Sound check', run.check?.ms],
    ['Claps', run.clap?.ms],
    ['Auto-align', run.align?.reliable ? run.align.ms : null],
  ].filter(([, ms]) => ms != null)
}

function prepareAlign() {
  const max = Math.max(1000, ...suggestions().map(([, ms]) => Math.ceil(ms / 100) * 100 + 200))
  $('shift').max = String(max)
  setShift(0)
  $('suggestions').innerHTML = suggestions()
    .map(([label, ms]) => `<button data-ms="${Math.round(ms / 5) * 5}" data-label="${label}">${label} · ${fmt(ms)} ms</button>`).join('')
  state.run.suggestion = null
  $('play').innerHTML = PLAY_LABEL
}

function setShift(ms) {
  const slider = $('shift')
  const v = Math.max(0, Math.min(Number(slider.max), Math.round(ms / 5) * 5))
  slider.value = String(v)
  $('shift-value').textContent = String(v)
}

const shiftMs = () => Number($('shift').value)

let playStartedAt = 0

function stopPlayback() {
  state.playing.forEach((n) => { try { n.stop() } catch {} })
  state.playing = []
  if ($('play')) $('play').innerHTML = PLAY_LABEL
}

// Base from `fromSec`; the take shifted earlier by the slider.
function playMix(fromSec = 0) {
  stopPlayback()
  const ctx = state.ctx
  const sr = ctx.sampleRate
  const T = ctx.currentTime + 0.1
  const base = ctx.createBufferSource()
  base.buffer = getBase()
  base.connect(ctx.destination)
  base.start(T, fromSec)
  base.onended = () => { if (state.playing.includes(base)) stopPlayback() }
  const take = ctx.createBufferSource()
  take.buffer = toBuffer(state.run.take.samples)
  const gain = ctx.createGain()
  gain.gain.value = 1.5
  take.connect(gain).connect(ctx.destination)
  // Take position on the base timeline, after the shift.
  const takeStart = state.run.take.rel / sr - shiftMs() / 1000
  const offsetInTake = fromSec - takeStart
  if (offsetInTake >= 0) take.start(T, offsetInTake)
  else take.start(T - offsetInTake)
  state.playing = [base, take]
  playStartedAt = T - fromSec
  $('play').innerHTML = STOP_LABEL
}

function playheadSec() {
  return state.playing.length ? Math.max(0, state.ctx.currentTime - playStartedAt) : 0
}

function shiftChanged() {
  $('shift-value').textContent = $('shift').value
  if (state.playing.length) playMix(playheadSec())
}

// ── Saving a run ────────────────────────────────────────────────────────────

function save(inTime) {
  stopPlayback()
  const run = state.run
  const yours = inTime ? shiftMs() : null
  const diff = (ms) => (ms == null || yours == null ? '' : fmt(ms - yours))
  const row = {
    time: new Date().toLocaleString(),
    device: $('device').value.trim(),
    detected: detected.summary,
    browser: browserName(),
    output: run.output,
    headphones: run.headphones,
    mic: micLabel(),
    echoCancel: state.stream?.getAudioTracks()[0]?.getSettings().echoCancellation ? 'on' : 'off',
    track: state.ownTrack ? 'Own track' : 'Drum beat',
    result: inTime ? 'In time' : "Couldn't get in time",
    yoursMs: inTime ? fmt(yours) : '',
    // Did they start from a suggestion, and how far did they move it by ear?
    startedFrom: run.suggestion ? run.suggestion.label : 'Slider only',
    adjustedBy: run.suggestion && inTime ? fmt(yours - run.suggestion.ms) : '',
    checkMs: fmt(run.check?.ms),
    checkHeard: run.check ? `${run.check.heard}/8` : 'skipped',
    clapMs: fmt(run.clap?.ms),
    claps: run.clap ? String(run.clap.n) : 'skipped',
    alignMs: fmt(run.align?.ms),
    alignTrust: run.align ? `${run.align.reliable ? 'yes' : 'no'} (${run.align.notes} notes, ${fmt(run.align.matchRate * 100)}% matched)` : '',
    reportedMs: fmt(reportedLatencyMs()),
    checkOff: diff(run.check?.ms),
    clapOff: diff(run.clap?.ms),
    alignOff: diff(run.align?.reliable ? run.align.ms : null),
    reportedOff: diff(reportedLatencyMs()),
  }
  state.log.push(row)
  saveLog()
  renderLog()
  renderDone(row, yours)
  showStep('done')
}

function renderDone(row, yours) {
  $('done-summary').textContent = yours == null
    ? "Noted that you couldn't get it in time. That's useful to know."
    : `You lined it up at ${yours} ms. Here's how close each automatic method got:`
  const methods = [
    ['Sound check', row.checkMs, row.checkOff],
    ['Claps', row.clapMs, row.clapOff],
    ['Auto-align', state.run.align?.reliable ? row.alignMs : '', row.alignOff],
    ['Browser estimate', row.reportedMs, row.reportedOff],
  ]
  $('done-table').innerHTML = yours == null ? '' : `<table><thead><tr><th>Method</th><th>Delay</th><th>Off by</th></tr></thead><tbody>${
    methods.map(([m, ms, off]) => `<tr><td>${m}</td><td>${ms ? ms + ' ms' : 'n/a'}</td><td>${off !== '' ? (off > 0 ? '+' : '') + off + ' ms' : ''}</td></tr>`).join('')
  }</tbody></table>`
  $('again-hint').hidden = !onHeadphones()
}

// ── Results log ─────────────────────────────────────────────────────────────

function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY)) || [] } catch { return [] }
}

function saveLog() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(state.log)) } catch {}
}

const LOG_COLUMNS = [
  ['time', 'Time'], ['device', 'Device'], ['detected', 'Detected'], ['browser', 'Browser'],
  ['output', 'Listening on'], ['headphones', 'Headphones'], ['mic', 'Mic'], ['echoCancel', 'Echo canc.'],
  ['track', 'Track'], ['result', 'Result'], ['yoursMs', 'Your alignment ms'],
  ['startedFrom', 'Started from'], ['adjustedBy', 'Adjusted by ear ms'],
  ['checkMs', 'Sound check ms'], ['checkHeard', 'Sound check heard'], ['checkOff', 'Sound check off by'],
  ['clapMs', 'Claps ms'], ['claps', 'Claps heard'], ['clapOff', 'Claps off by'],
  ['alignMs', 'Auto-align ms'], ['alignTrust', 'Auto-align trusted'], ['alignOff', 'Auto-align off by'],
  ['reportedMs', 'Browser estimate ms'], ['reportedOff', 'Browser estimate off by'],
]

function renderLog() {
  $('results-count').textContent = state.log.length ? `(${state.log.length})` : ''
  $('log').innerHTML = state.log.length
    ? `<div class="scroll"><table><thead><tr>${LOG_COLUMNS.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${state.log.slice().reverse().map((r) => `<tr>${LOG_COLUMNS.map(([k]) => `<td>${escapeHtml(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No results yet.</p>'
}

function logAsCsv() {
  const cell = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [LOG_COLUMNS.map(([, h]) => h).join(','), ...state.log.map((r) => LOG_COLUMNS.map(([k]) => cell(r[k])).join(','))].join('\n')
}

function resultsFileName() {
  const device = $('device').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `overdub-test-${device || 'results'}.csv`
}

function canShareFiles() {
  try { return !!navigator.canShare?.({ files: [new File([''], 'x.csv', { type: 'text/csv' })] }) } catch { return false }
}

async function shareLog() {
  if (!state.log.length) return setStatus('log-status', 'No results to share yet.', 'bad')
  const file = new File([logAsCsv()], resultsFileName(), { type: 'text/csv' })
  try {
    await navigator.share({ files: [file], title: 'Overdub test results', text: `Overdub test results from ${$('device').value.trim() || 'my device'}` })
  } catch (err) {
    if (err.name !== 'AbortError') setStatus('log-status', "Couldn't share. Use Download CSV instead.", 'bad')
  }
}

function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

// ── Device detection ────────────────────────────────────────────────────────
// Browsers hide exact models. Android Chrome usually reports it (pre-filled);
// iPhone, iPad and Mac only give family, OS version and screen size.

async function detectDevice() {
  const ua = navigator.userAgent
  const family = /iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1 ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Unknown'
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
  const size = `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 100) / 100}x`
  detected.summary = [family, detected.model, os, size].filter(Boolean).join(' · ')
  return family
}

function browserName() {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Other'
  const b = /EdgA?\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone
  return `${b} · ${os}${standalone ? ' · home screen' : ''}`
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

function remember(id) {
  const el = $(id)
  try { el.value = localStorage.getItem(`overdub-lab-${id}`) || el.value } catch {}
  el.addEventListener('change', () => { try { localStorage.setItem(`overdub-lab-${id}`, el.value) } catch {} })
}

function syncHeadphonesField() {
  $('headphones-field').hidden = !onHeadphones()
}

function wire() {
  if (!window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) {
    setStatus('setup-status', "This browser can't run the test. Use a recent Chrome or Safari.", 'bad')
    $('start').disabled = true
  }
  remember('device')
  remember('headphones')
  try {
    const saved = localStorage.getItem('overdub-lab-output')
    const radio = saved && document.querySelector(`input[name=output][value="${saved}"]`)
    if (radio) radio.checked = true
  } catch {}
  document.querySelectorAll('input[name=output]').forEach((r) => r.addEventListener('change', () => {
    syncHeadphonesField()
    try { localStorage.setItem('overdub-lab-output', output()) } catch {}
  }))
  syncHeadphonesField()

  detectDevice().then((family) => {
    const input = $('device')
    if (!input.value.trim() && detected.model) input.value = detected.model
    if (!detected.model && (family === 'iPhone' || family === 'iPad')) input.placeholder = `Which ${family}? e.g. ${family} 13`
    if (!detected.model && family === 'Mac') input.placeholder = 'Which Mac? e.g. MacBook Air M2'
    $('device-help').textContent = detectedHint()
  })
  $('device').addEventListener('input', () => {
    if ($('device').classList.contains('invalid') && $('device').value.trim()) requireDevice()
  })

  $('start').addEventListener('click', start)
  $('run-check').addEventListener('click', runCheck)
  $('check-again').addEventListener('click', () => { prepareCheck(); runCheck() })
  $('check-continue').addEventListener('click', () => { prepareClap(); showStep('clap') })
  $('run-clap').addEventListener('click', runClap)
  $('clap-again').addEventListener('click', () => { prepareClap(); runClap() })
  $('clap-continue').addEventListener('click', () => showStep('record'))
  $('clap-skip').addEventListener('click', () => { state.run.clap = null; showStep('record') })
  $('base-file').addEventListener('change', (e) => e.target.files[0] && loadOwnTrack(e.target.files[0]))
  $('run-record').addEventListener('click', runRecord)

  $('play').addEventListener('click', () => (state.playing.length ? stopPlayback() : playMix(0)))
  $('shift').addEventListener('input', () => { $('shift-value').textContent = $('shift').value })
  $('shift').addEventListener('change', shiftChanged)
  $('minus').addEventListener('click', () => { setShift(shiftMs() - 5); shiftChanged() })
  $('plus').addEventListener('click', () => { setShift(shiftMs() + 5); shiftChanged() })
  $('suggestions').addEventListener('click', (e) => {
    const ms = e.target.closest('button')?.dataset.ms
    if (ms != null) {
      state.run.suggestion = { label: e.target.closest('button').dataset.label, ms: Number(ms) }
      setShift(Number(ms))
      shiftChanged()
    }
  })
  $('save').addEventListener('click', () => save(true))
  $('cant').addEventListener('click', () => save(false))
  $('rerecord').addEventListener('click', () => { stopPlayback(); showStep('record') })

  $('test-again').addEventListener('click', async () => {
    // Reopen audio so a reconnected pair of headphones is picked up.
    await start()
  })
  $('change-setup').addEventListener('click', async () => { await closeAudio(); showStep('setup') })

  if (canShareFiles()) {
    $('share-log').hidden = false
    $('share-done').hidden = false
  }
  $('share-log').addEventListener('click', shareLog)
  $('share-done').addEventListener('click', shareLog)
  $('dl-log').addEventListener('click', () => download(new Blob([logAsCsv()], { type: 'text/csv' }), resultsFileName()))
  $('dl-done').addEventListener('click', () => download(new Blob([logAsCsv()], { type: 'text/csv' }), resultsFileName()))
  $('clear-log').addEventListener('click', () => {
    if (confirm('Delete all saved results on this device?')) { state.log = []; saveLog(); renderLog() }
  })
  renderLog()
}

wire()
