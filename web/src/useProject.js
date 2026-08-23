import { useCallback, useEffect, useRef } from 'react';
import * as apiClient from './api.js';

// Keep the project across reloads.
//
// AudioBuffers cannot be serialized, so what gets saved is everything
// needed to rebuild them: the session id, the tempo and key, and each
// track's clips with the URL its audio came from. On load the metadata
// comes back immediately and the audio is re-fetched from the backend,
// which still has every stem on disk.
//
// MIDI clips restore completely from the saved notes — there is nothing to
// re-fetch, because a MIDI part is its notes.

const KEY = 'btg.project';
const SAVE_DEBOUNCE = 600;

// Module-level, not a ref: StrictMode mounts the app twice in development,
// and a per-instance ref is fresh on the second mount — so the restore ran
// twice and every track in the project was duplicated on each reload.
let restoreStarted = false;

export function useProject({ engine, sessionId, setSessionId, studio, onRestored }) {
  const restoredRef = useRef(false);
  const timerRef = useRef(null);

  const snapshot = useCallback(() => ({
    version: 1,
    sessionId,
    bpm: studio.bpm,
    key: studio.key,
    mode: studio.mode,
    tracks: engine.tracks.map((t) => ({
      name: t.name,
      kind: t.kind,
      instrument: t.instrument ?? null,
      muted: t.muted,
      soloed: t.soloed,
      volume: t.volume,
      clips: t.clips.map((c) => ({
        start: c.start,
        duration: c.duration,
        durationBeats: c.durationBeats,
        offset: c.offset,
        notes: c.notes ?? null,
        part: c.part ?? null,
        prompt: c.prompt ?? '',
        seed: c.seed ?? null,
        backendUsed: c.backendUsed ?? null,
        startBar: c.startBar ?? 0,
        audioUrl: c.audioUrl ?? null,
        midiUrl: c.midiUrl ?? null,
      })),
    })),
  }), [engine.tracks, sessionId, studio.bpm, studio.key, studio.mode]);

  const restoreSnapshot = useCallback(async (saved) => {
    if (!saved?.tracks?.length) return false;

    engine.clear();
    if (saved.sessionId) setSessionId(saved.sessionId);
    if (saved.bpm) studio.setBpm(saved.bpm);
    if (saved.key) studio.setKey(saved.key);
    if (saved.mode) studio.setMode(saved.mode);

    for (const track of saved.tracks) {
      if (track.kind === 'midi') {
        const clip = track.clips?.[0];
        if (!clip) continue;
        engine.addMidiTrack(track.name, track.instrument, {
          start: clip.start,
          duration: clip.duration,
          durationBeats: clip.durationBeats,
          notes: clip.notes || [],
          midiUrl: clip.midiUrl || null,
          muted: track.muted,
          soloed: track.soloed,
          volume: track.volume,
        });
        continue;
      }

      const trackId = engine.addTrack(track.name, track.kind, {
        instrument: track.instrument,
        muted: track.muted,
        soloed: track.soloed,
        volume: track.volume,
      });
      for (const clip of track.clips || []) {
        if (!clip.audioUrl) continue;
        try {
          const response = await fetch(clip.audioUrl);
          if (!response.ok) continue;
          const buffer = await engine.context().decodeAudioData(await response.arrayBuffer());
          engine.addClip(trackId, buffer, {
            start: clip.start,
            duration: clip.duration,
            offset: clip.offset,
            part: clip.part,
            prompt: clip.prompt,
            seed: clip.seed,
            backendUsed: clip.backendUsed,
            startBar: clip.startBar,
            audioUrl: clip.audioUrl,
          });
        } catch {
          // A missing clip should not block the rest of the project.
        }
      }
    }
    onRestored?.(saved);
    return true;
  }, [engine, setSessionId, studio, onRestored]);

  // --- save --------------------------------------------------------------

  useEffect(() => {
    // Do not save until a restore has been attempted, or the empty initial
    // state overwrites the saved project before it can be read back.
    if (!restoredRef.current) return undefined;

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const current = snapshot();
      try {
        localStorage.setItem(KEY, JSON.stringify(current));
      } catch {
        // Quota, most likely. Losing autosave is not worth breaking the app.
      }
      if (sessionId) {
        apiClient.saveTimeline(sessionId, current).catch(() => {});
      }
    }, SAVE_DEBOUNCE);

    return () => clearTimeout(timerRef.current);
  }, [snapshot, sessionId]);

  // --- restore -----------------------------------------------------------

  useEffect(() => {
    // StrictMode re-runs this effect on the same instance; restoredRef is
    // shared, and the first run's completion will set it.
    if (restoreStarted) return undefined;
    restoreStarted = true;

    (async () => {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      } catch {
        saved = null;
      }

      if (saved?.sessionId) {
        try {
          const timeline = await apiClient.getTimeline(saved.sessionId);
          if (timeline?.tracks?.length) {
            saved = { ...timeline, sessionId: saved.sessionId };
          }
        } catch {
          // Backend session may have been deleted; local snapshot is fallback.
        }
      }

      if (!saved?.tracks?.length) {
        restoredRef.current = true;
        return;
      }
      await restoreSnapshot(saved);

      restoredRef.current = true;
    })();

    // No cleanup: StrictMode's dev-only unmount/remount would cancel the
    // in-flight restore on the mount that survives. The module guard above
    // already makes this a single run.
    return undefined;
    // Runs once on mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = useCallback(() => {
    localStorage.removeItem(KEY);
  }, []);

  return { clear, restore: restoreSnapshot };
}
