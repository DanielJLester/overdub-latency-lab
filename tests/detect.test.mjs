import { makeChirpTrain, measureLatency, stats, detectOnsets, offsetsFromBeats, encodeWav } from '../detect.js'
const sr = 48000
let fails = 0
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!ok) fails++ }
function rand(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1 }

// Simulated loopback: delay, attenuation, room echo, noise, optional band-limit + jitter
function loop({ delayMs, gain = 0.3, noise = 0.01, echo = true, lowpass = false, jitterMs = 0, preMs = 500 }) {
  const { buffer, offsets, chirp } = makeChirpTrain(sr)
  const pre = Math.round(sr * preMs / 1000)
  const rec = new Float32Array(buffer.length + pre + sr)
  const r = rand(7)
  offsets.forEach((o, i) => {
    const d = Math.round(sr * (delayMs + (jitterMs ? r() * jitterMs : 0)) / 1000)
    for (let j = 0; j < chirp.length; j++) {
      rec[pre + o + d + j] += chirp[j] * 0.8 * gain
      if (echo) rec[pre + o + d + j + 700] += chirp[j] * 0.8 * gain * 0.4
    }
  })
  if (lowpass) { let y = 0; for (let i = 0; i < rec.length; i++) { y += 0.35 * (rec[i] - y); rec[i] = y } }
  for (let i = 0; i < rec.length; i++) rec[i] += r() * noise
  return { rec, expected: offsets.map((o) => o + pre), chirp }
}

for (const [label, opts] of [
  ['wired 35 ms', { delayMs: 35 }],
  ['bluetooth 240 ms', { delayMs: 240 }],
  ['bluetooth 480 ms, band-limited + noisy', { delayMs: 480, lowpass: true, noise: 0.03 }],
  ['quiet bleed 5% gain', { delayMs: 60, gain: 0.05 }],
]) {
  const { rec, expected, chirp } = loop(opts)
  const res = measureLatency(rec, chirp, expected, sr)
  const s = stats(res.filter((x) => x.found).map((x) => x.latencyMs))
  check(label, s && s.n === 8 && Math.abs(s.mean - opts.delayMs) < 1, `mean=${s?.mean.toFixed(2)} sd=${s?.sd.toFixed(2)} found=${s?.n}/8 score=${res[0].score.toFixed(2)}`)
}
{
  const { rec, expected, chirp } = loop({ delayMs: 120, jitterMs: 15 })
  const s = stats(measureLatency(rec, chirp, expected, sr).filter((x) => x.found).map((x) => x.latencyMs))
  check('jitter shows up in sd', s.sd > 4 && s.sd < 15, `sd=${s.sd.toFixed(2)}`)
}
{
  // headphones on ears: nothing reaches the mic
  const { rec, expected, chirp } = loop({ delayMs: 50, gain: 0 })
  const res = measureLatency(rec, chirp, expected, sr)
  check('no bleed → nothing found', res.every((x) => !x.found), `max score=${Math.max(...res.map((x) => x.score)).toFixed(2)}`)
}
{
  // near-silence that happens to match by shape (e.g. compressed silence):
  // a perfect-shape chirp at -75 dBFS must not count as "heard"
  const { rec, expected, chirp } = loop({ delayMs: 50, gain: 0.0002, noise: 0 })
  const res = measureLatency(rec, chirp, expected, sr)
  check('near-silent match is not "heard"', res.every((x) => !x.found), `score=${res[0].score.toFixed(2)} level=${res[0].levelDb.toFixed(0)} dB`)
}
{
  // a real but quiet leak well above the noise still counts
  const { rec, expected, chirp } = loop({ delayMs: 50, gain: 0.01, noise: 0.0003 })
  const res = measureLatency(rec, chirp, expected, sr)
  check('quiet real leak (-42 dB over -70 dB noise) is heard', res.every((x) => x.found), `level=${res[0].levelDb.toFixed(0)} dB`)
}
{
  // claps 70 ms late on an 80 BPM grid, human spread ±15 ms
  const beat = Math.round(sr * 0.75), r = rand(3), sig = new Float32Array(beat * 34)
  for (let i = 0; i < sig.length; i++) sig[i] = r() * 0.003
  for (let k = 1; k <= 32; k++) {
    const at = k * beat + Math.round(sr * (0.07 + r() * 0.015))
    for (let j = 0; j < 2000; j++) sig[at + j] += r() * 0.6 * Math.exp(-j / 300)
  }
  const on = detectOnsets(sig, sr)
  const offs = offsetsFromBeats(on, beat, sr)
  const s = stats(offs)
  check('claps: 32 onsets, median ≈ 70 ms', on.length === 32 && Math.abs(s.median - 70) < 8, `onsets=${on.length} median=${s.median.toFixed(1)} sd=${s.sd.toFixed(1)}`)
}
{
  // Xiaomi round 1: ~660 ms Bluetooth delay
  const claps = (beatMs, delayMs) => {
    const beat = Math.round(sr * beatMs / 1000), r = rand(9), sig = new Float32Array(beat * 26)
    for (let k = 1; k <= 24; k++) {
      const at = k * beat + Math.round(sr * (delayMs + r() * 10) / 1000)
      for (let j = 0; j < 2000 && at + j < sig.length; j++) sig[at + j] += r() * 0.6 * Math.exp(-j / 300)
    }
    return { on: detectOnsets(sig, sr), beat }
  }
  const at80 = claps(750, 660)
  const wrapped = stats(offsetsFromBeats(at80.on, at80.beat, sr)).median
  const anchored = stats(offsetsFromBeats(at80.on, at80.beat, sr, { centerMs: 660 })).median
  check('80 BPM without anchor wraps 660 ms (the round-1 bug)', wrapped < 0, `median=${wrapped.toFixed(0)}`)
  check('80 BPM anchored to Test A reads 660 ms', Math.abs(anchored - 660) < 10, `median=${anchored.toFixed(0)}`)
  const at60 = claps(1000, 660)
  const plain60 = stats(offsetsFromBeats(at60.on, at60.beat, sr)).median
  check('60 BPM reads 660 ms even without an anchor', Math.abs(plain60 - 660) < 10, `median=${plain60.toFixed(0)}`)
}
{
  const blob = encodeWav(new Float32Array([0, 0.5, -1]), sr)
  check('wav size', blob.size === 44 + 6)
}
// speed: 8 chirps searched over 820 ms each
{
  const { rec, expected, chirp } = loop({ delayMs: 200 })
  const t = performance.now(); measureLatency(rec, chirp, expected, sr); const ms = performance.now() - t
  check('fast enough', ms < 1500, `${ms.toFixed(0)} ms on this machine`)
}
process.exit(fails ? 1 : 0)
