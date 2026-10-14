# Overdub Latency Lab

A **throwaway** feasibility prototype for the StickyNotes "overdub" feature. It is
deliberately separate from the StickyNotes app; nothing here is meant to be reused.

**Question it answers:** can a phone (or laptop) browser record a new part while
playing back an existing clip, so that

1. the playback does **not** leak into the new recording, and
2. the new part lines up **in time**, including over **Bluetooth** headphones
   (required for v1: most phones have no headphone jack)?

Testers must fill in **This device** (make and model) before testing. Browsers hide
the exact model for privacy: Android Chrome usually reports it (and it's pre-filled),
iPhone/iPad/Mac only report the family, OS version and screen size. Whatever is
detected is saved in every result row as **Detected**.

Open the page on the device to test: **https://danieljlester.github.io/overdub-latency-lab/**
(must be https for mic access). Results stay on the device until you copy or
download them.

## What it measures

**Test A, automatic delay meter.** Plays 8 short chirps and finds them in the mic
recording. Reports the delay (median), how much it varies between chirps, how loud
the playback was in the recording (leakage), and what the browser *claims* the
delay is. It also runs the app's current recorder (MediaRecorder) alongside, to
show whether its timing is predictable.

**Test B, record over a track.** Plays a 24-second, 80 BPM drum loop while you clap
on every beat (or play along). It measures how late the claps landed, then plays
your take back with the base, with a choice of timing corrections. You rate whether
it sounded in time. Downloads: the raw take and the mix, as WAV.

The mic is recorded on the **same audio clock** as the playback (an AudioWorklet),
so the only delay left is the device's own, which a real app can correct for.

## Test plan

For each device × output, with the device's built-in mic selected where possible:

| Output | Test A (×3) | Test A, leakage | Test B |
| --- | --- | --- | --- |
| Speaker, echo cancellation off | phone flat, 70% volume | — | clap along |
| Speaker, echo cancellation on | same | — | play an instrument: does it cut out? |
| Bluetooth headphones | earbud held against the mic | worn normally | clap along |
| AirPods | earbud held against the mic | worn normally | clap along |
| Wired / USB-C (if available) | earbud held against the mic | worn normally | clap along |

Devices worth covering: an iPhone in Safari **and** added to the home screen, an
Android phone in Chrome, a laptop in Chrome and Safari.

Note anything odd: playback getting quieter or switching to the earpiece when the
mic starts, Bluetooth audio turning low-quality (headset/call mode), the mic label
showing the headset's mic.

## Pass bar (suggested)

| Measure | Target |
| --- | --- |
| Delay varies between chirps/runs (Test A "±") | under ~10 ms |
| Timing after correction (Test B) | rated "In time" |
| Leakage with headphones worn (Test A) | "not heard" |
| Browser-reported delay vs measured | close enough to skip calibration? (nice to have) |

A **large but steady** delay (e.g. Bluetooth at 250 ms ± 5 ms) is fine: the app
can shift the take by that amount. An **unsteady** delay is the real blocker.

## Files

- `index.html`, `app.js`: the page.
- `capture-worklet.js`: records the mic on the playback clock.
- `detect.js`: chirp/clap detection and stats (pure functions).
- `tests/detect.test.mjs`: `node tests/detect.test.mjs` checks the detection against
  synthetic recordings with known delays, noise, echo and band-limiting.

No build step and no dependencies. GitHub Pages serves the files as they are.
