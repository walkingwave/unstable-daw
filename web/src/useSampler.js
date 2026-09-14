import { useCallback, useRef, useState } from 'react';
import * as apiClient from './api.js';
import { matchPrompt, loadSoundfont } from './soundfonts.js';

// The sampler behind every MIDI track. Two sources feed it:
//
//   soundfont  the prompt names a real instrument ("bowed cello, warm and
//              woody" -> cello), so play real recordings of it — a General
//              MIDI multisample, one recording per key across the whole
//              keyboard. This is why a cello sounds like a cello.
//   generated  the prompt names nothing any library holds ("glass bells
//              underwater"), so ask the model for a few one-shots and
//              pitch-shift them. Less faithful, but it can make anything.
//
// Either way the MIDI itself is played back exactly as written by the
// browser — the model never renders a melody, because asking it to
// rewrites the tune. And once an instrument is loaded, editing notes needs
// no generation at all.

export function useSampler() {
  // instrumentId -> { type: 'soundfont', buffers: Map<pitch, AudioBuffer> }
  //              | { type: 'generated', samples: [{actualPitch, buffer}] }
  const loadedRef = useRef(new Map());
  // instrumentId -> Promise of the entry, while a load is in flight.
  const pendingRef = useRef(new Map());
  const ctxRef = useRef(null);
  // Every instrument currently loading. A single id was not enough: restoring
  // a project loads several at once, and the first to finish cleared the
  // "loading…" label on slots whose sound was still on its way.
  const [loadingIds, setLoadingIds] = useState(() => new Set());

  const context = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

  const isLoaded = useCallback((instrument) => {
    return instrument ? loadedRef.current.has(instrument.id) : false;
  }, []);

  const isLoading = useCallback(
    (instrument) => (instrument ? loadingIds.has(instrument.id) : false),
    [loadingIds],
  );

  const loadGenerated = useCallback(
    async (instrument, backend) => {
      const { samples } = await apiClient.instrumentSamples({
        prompt: instrument.prompt,
        backend,
      });
      const decoded = await Promise.all(
        samples.map(async (s) => ({
          // Takes are not generated at a requested pitch — each lands
          // wherever it lands and reports it, and playback transposes
          // from there.
          actualPitch: s.actual_pitch,
          buffer: await context().decodeAudioData(
            await (await fetch(s.url)).arrayBuffer(),
          ),
        })),
      );
      return { type: 'generated', samples: decoded };
    },
    [context],
  );

  // Resolve an instrument to samples. Routed by IDENTITY, not by prompt:
  // factory instruments (id "f-…") are stock sounds and load their soundfont,
  // never costing a generation; an instrument the user created by describing
  // it is the whole point of describing it — it is generated through Stable
  // Audio even when the description happens to name a GM instrument.
  // Soundfonts remain the fallback either way, so an offline demo or a failed
  // generation still makes sound.
  const resolve = useCallback(
    async (instrument, backend) => {
      const gm = matchPrompt(instrument.prompt);
      const isFactory = String(instrument.id || '').startsWith('f-');
      let entry = null;

      if (isFactory && gm) {
        try {
          entry = { type: 'soundfont', gm, buffers: await loadSoundfont(gm, context()) };
        } catch (error) {
          console.warn(`soundfont ${gm} unavailable, generating instead:`, error);
        }
      }
      if (!entry) {
        try {
          entry = await loadGenerated(instrument, backend);
        } catch (error) {
          if (!gm) throw error;
          console.warn('generation failed, falling back to soundfont:', error);
          entry = { type: 'soundfont', gm, buffers: await loadSoundfont(gm, context()) };
        }
      }
      return entry;
    },
    [context, loadGenerated],
  );

  // Loads are shared while in flight. A restore, a new track and a slot click
  // can all ask for the same instrument within a second of each other, and
  // each used to start its own generation — paying for the same one-shots
  // two or three times.
  const load = useCallback(
    async (instrument, { backend } = {}) => {
      if (!instrument?.prompt) throw new Error('this instrument has no description');
      const id = instrument.id;
      if (loadedRef.current.has(id)) return loadedRef.current.get(id);
      if (pendingRef.current.has(id)) return pendingRef.current.get(id);

      const task = resolve(instrument, backend).then((entry) => {
        loadedRef.current.set(id, entry);
        return entry;
      });
      pendingRef.current.set(id, task);
      setLoadingIds((ids) => new Set(ids).add(id));
      try {
        return await task;
      } finally {
        pendingRef.current.delete(id);
        setLoadingIds((ids) => {
          const next = new Set(ids);
          next.delete(id);
          return next;
        });
      }
    },
    [resolve],
  );

  // The source nearest the requested pitch, so nothing is stretched
  // further than it has to be. A soundfont usually holds the exact key.
  const pick = (entry, pitch) => {
    if (entry.type === 'soundfont') {
      const exact = entry.buffers.get(pitch);
      if (exact) return { buffer: exact, actualPitch: pitch };
      let best = null;
      for (const [p, buffer] of entry.buffers) {
        if (!best || Math.abs(p - pitch) < Math.abs(best.actualPitch - pitch)) {
          best = { buffer, actualPitch: p };
        }
      }
      return best;
    }
    if (!entry.samples?.length) return null;
    return entry.samples.reduce((best, s) =>
      Math.abs(s.actualPitch - pitch) < Math.abs(best.actualPitch - pitch) ? s : best,
    );
  };


  // Sample recordings arrive at whatever level they were captured at —
  // soundfont notes often peak around 0.2 — while generated stems play near
  // full scale, so MIDI tracks sounded buried. Per-buffer makeup gain
  // normalises each sample toward a common peak. Cached per buffer; capped
  // so a near-silent sample is not boosted into audible noise.
  const makeupRef = useRef(new WeakMap());
  const makeupFor = (buffer) => {
    const cache = makeupRef.current;
    let cached = cache.get(buffer);
    if (cached != null) return cached;
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    const gain = peak > 0.001 ? Math.min(0.9 / peak, 6) : 1;
    cache.set(buffer, gain);
    return gain;
  };

  /**
   * Schedule one note. `when` and `duration` are in AudioContext seconds.
   * Returns the source so a caller can stop it early.
   */
  const play = useCallback(
    (instrument, pitch, when, duration, { gain = 1, destination } = {}) => {
      const entry = loadedRef.current.get(instrument?.id);
      if (!entry) return null;

      const ctx = context();
      const sample = pick(entry, pitch);
      if (!sample) return null;
      const source = ctx.createBufferSource();
      source.buffer = sample.buffer;
      source.playbackRate.value = 2 ** ((pitch - sample.actualPitch) / 12);

      // Short attack and release. Without the release a note cut shorter
      // than its sample ends on a click. Soundfont recordings carry their
      // own natural release tail, so give them a longer ramp to let it
      // breathe instead of chopping it at the note boundary.
      const level = gain * makeupFor(sample.buffer);
      const env = ctx.createGain();
      // Generated one-shots used to get a 20ms tail — factory soundfonts
      // ring for 250ms, and that difference alone made generated
      // instruments sound abruptly chopped next to them.
      const tail = entry.type === 'soundfont' ? 0.25 : 0.15;
      const release = Math.min(entry.type === 'soundfont' ? 0.2 : 0.12, duration / 2);
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(level, when + 0.005);
      env.gain.setValueAtTime(level, when + duration - release);
      env.gain.linearRampToValueAtTime(0.0001, when + duration + tail);

      source.connect(env).connect(destination || ctx.destination);
      source.start(when);
      source.stop(when + duration + tail + 0.02);
      return source;
    },
    [context],
  );

  /**
   * Sound a note now and hold it until released. Used for live playing,
   * where the length is not known when the key goes down — `play` cannot
   * serve that case because it needs a duration up front.
   *
   * Returns a handle whose `stop()` ramps the note out.
   */
  const noteOn = useCallback(
    (instrument, pitch, { gain = 1, destination } = {}) => {
      const entry = loadedRef.current.get(instrument?.id);
      if (!entry) return null;

      const ctx = context();
      ctx.resume();
      const sample = pick(entry, pitch);
      if (!sample) return null;
      const source = ctx.createBufferSource();
      source.buffer = sample.buffer;
      source.playbackRate.value = 2 ** ((pitch - sample.actualPitch) / 12);

      if (entry.type === 'generated') {
        // Hold by looping: a three-second one-shot would otherwise stop
        // dead under a longer press. Loop from past the attack so the
        // transient is not retriggered, but clamp it — trimming can leave a
        // sample short enough that a fixed loop start would sit beyond its
        // end, which silently produces no sound at all.
        const attack = Math.min(0.25, sample.buffer.duration * 0.25);
        source.loop = true;
        source.loopStart = attack;
        source.loopEnd = sample.buffer.duration;
      }
      // Soundfont recordings are left unlooped: they carry a natural decay
      // and release, and looping compressed audio mid-note clicks. A very
      // long press simply lets the note ring out, like a real sampler
      // without loop points.

      const env = ctx.createGain();
      env.gain.setValueAtTime(0, ctx.currentTime);
      env.gain.linearRampToValueAtTime(gain * makeupFor(sample.buffer), ctx.currentTime + 0.005);
      source.connect(env).connect(destination || ctx.destination);
      source.start();

      return {
        stop() {
          const now = ctx.currentTime;
          const release = 0.12;
          env.gain.cancelScheduledValues(now);
          env.gain.setValueAtTime(env.gain.value, now);
          env.gain.linearRampToValueAtTime(0.0001, now + release);
          // Stop after the ramp, not on it, or the release is cut off and
          // clicks — the thing the ramp exists to prevent.
          source.stop(now + release + 0.02);
        },
      };
    },
    [context],
  );

  return { load, play, noteOn, isLoaded, isLoading, context };
}
