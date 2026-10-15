# Overdub Latency Lab

A **throwaway** feasibility prototype for the StickyNotes "overdub" feature. It is
deliberately separate from the StickyNotes app; nothing here is meant to be reused.

**Question it answers:** can a phone (or laptop) browser record a new part while
playing back an existing clip, so that the new part lines up **in time**, including
over **Bluetooth** headphones (required for v1: most phones have no headphone jack)?

Round 1 showed no leakage through worn headphones, and that Bluetooth delays are
large (157–660 ms) and the browser's own estimate is wrong, so the app has to
correct the delay. This version tests how well that can be done automatically.

Testers must fill in **This device** (make and model) before testing. Browsers hide
the exact model for privacy: Android Chrome usually reports it (and it's pre-filled),
iPhone/iPad/Mac only report the family, OS version and screen size. Whatever is
detected is saved in every result row as **Detected**.

Open the page on the device to test: **https://danieljlester.github.io/overdub-latency-lab/**
(must be https for mic access). Results stay on the device until you copy or
download them.

## How it works

A guided test, about 3 minutes per run:

1. **Your setup.** Device (required), what you're listening on, headphones model.
2. **Sound check (automatic).** Plays chirps and listens for them. Needs the
   device to hear itself: an earbud held against the mic, or the speaker.
3. **Clap along.** Clap on 10 beeps at a fixed tempo (no song tempo needed).
4. **Record a take.** Play, sing or clap over a drum beat or your own track.
   **Auto-align** then estimates the delay from the take itself; it only counts
   when at least 8 notes line up with the track (so not on sustained parts).
5. **Line it up.** Move a slider until the take sits in time, by ear. That's the
   reference: each automatic method is scored against it ("off by").

The mic is recorded on the same audio clock as the playback (AudioWorklet), and
with headphones the device's built-in mic is preferred automatically.

## What we want to learn

- Which automatic method (sound check, claps, auto-align, browser estimate)
  lands closest to what people line up by ear, per device and headphones.
- Whether Bluetooth delay changes between sessions: run it, disconnect and
  reconnect the headphones, then **Test again**.

Each run saves one row: setup, every method's delay, your alignment, how far
each method was off, and whether you started from a suggestion and how much
you then adjusted by ear.

## Files

- `index.html`, `app.js`: the page.
- `capture-worklet.js`: records the mic on the playback clock.
- `detect.js`: chirp/clap detection and stats (pure functions).
- `tests/detect.test.mjs`: `node tests/detect.test.mjs` checks chirp, clap and
  auto-align detection against synthetic recordings with known delays.

No build step and no dependencies. GitHub Pages serves the files as they are.
