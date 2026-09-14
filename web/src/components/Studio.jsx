import { useCallback, useEffect, useRef, useState } from 'react';
import ClipView from './ClipView.jsx';
import MidiEditor from './MidiEditor.jsx';
import InstrumentSlot from './InstrumentSlot.jsx';
import StudioRecorder from './StudioRecorder.jsx';
import * as apiClient from '../api.js';
import { MIN_CLIP_SECONDS, trimClipPatch } from '../timelineOps.js';

// Timeline studio (light, on-brand) with the controls a basic DAW needs:
// grid, zoom, adjustable snap (incl. off-grid), Ableton-style clip gestures,
// clip trim + split + duplicate, section highlight, loop, keyboard shortcuts.

const LANE_H = 76;
const HEADER_W = 168;
const RULER_H = 26;
const MIN_CLIP = MIN_CLIP_SECONDS;

const KIND_COLOR = {
  vocal: '#e6c3b3',
  bass: '#c3cae6',
  drums: '#e8dcb4',
  piano: '#c4dcc0',
  harmony: '#d7c6df',
  melody: '#e3c9a8',
  guitar: '#bfd9d2',
  // A mix is the whole band, so it gets its own colour rather than the
  // generic audio grey — it is the one track that is the song.
  mix: '#d9c2c2',
  audio: '#c4d4d6',
};
const colorFor = (kind) => KIND_COLOR[kind] || KIND_COLOR.audio;

const fmt = (s) => {
  if (!s || !isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const SNAPS = [
  { id: 'bar', label: 'Bar', div: 1 },
  { id: 'half', label: '1/2', div: 2 },
  { id: 'beat', label: 'Beat', div: 4 },
  { id: '8th', label: '1/8', div: 8 },
  { id: 'off', label: 'Off', div: 0 },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export default function Studio({
  engine, bpm, keyName, mode, onBpm, onKey, onMode, detected,
  onGenerateStem, onGenerateSong, onComposeMidi, onApplySettings, onGenerateFromReference, onRenderMidi, sessionId,
  instruments = [], onCreateInstrument, sampler, backend, onUploadAudio,
}) {
  const {
    tracks,
    playing,
    position,
    duration,
    context,
    getBuffer,
    addTrackWithClip,
    addClip,
    moveClip,
    updateClip,
    patchClip,
    splitClip,
    extractRegion,
    duplicateClip,
    duplicateRegion,
    removeClip,
    removeRegion,
    removeTrack,
    replaceRegion,
    setTrackProp,
    addTrack,
    addMidiTrack,
    setClipNotes,
    attachBuffer,
    beginGesture,
    undo,
    redo,
    canUndo,
    canRedo,
    play,
    pause,
    stop,
    seek,
    loop,
    setLoop,
  } = engine;

  const secondsPerBar = (60 / (bpm || 120)) * 4;
  const [pps, setPps] = useState(34);
  const [snapId, setSnapId] = useState('bar');
  const [selected, setSelected] = useState(null);
  const [region, setRegion] = useState(null); // {clipId, a, b}
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [recentStudioOperations, setRecentStudioOperations] = useState([]);
  const scrollRef = useRef(null);

  const snapDiv = SNAPS.find((s) => s.id === snapId)?.div ?? 1;
  const snapSec = snapDiv > 0 ? secondsPerBar / snapDiv : 0;
  const snap = (t) => (snapSec > 0 ? Math.round(t / snapSec) * snapSec : t);
  const quarterBarSec = secondsPerBar / 4;
  const snapQuarterBar = (t) => Math.round(t / quarterBarSec) * quarterBarSec;

  const laneW = Math.max(1200, (duration + 8) * pps);
  const timeToX = (t) => t * pps;
  const xToTime = (x) => x / pps;

  const zoom = (dir) => setPps((p) => Math.max(8, Math.min(220, dir > 0 ? p * 1.35 : p / 1.35)));

  const selTrack = selected ? tracks.find((t) => t.id === selected.trackId) : null;
  const selClip = selTrack?.clips.find((c) => c.id === selected.clipId) || null;
  // The piano roll owns the keyboard while it is open. Both it and the
  // timeline listen for Space on the window, so without this a single press
  // started the transport and the roll at once and everything played twice.
  const midiEditorOpen = !!(selClip && selTrack && selTrack.kind === 'midi');

  const recordStudioOperation = useCallback((operation) => {
    const entry = {
      id: operation.id || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      created_at: operation.created_at || new Date().toISOString(),
      ...operation,
    };
    setRecentStudioOperations((prev) => [...prev, entry].slice(-30));
    if (!sessionId) return;
    apiClient.recordOperation(sessionId, operation).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setRecentStudioOperations([]);
      return undefined;
    }
    apiClient.listOperations(sessionId, 30)
      .then((ops) => {
        if (!cancelled) setRecentStudioOperations(Array.isArray(ops) ? ops : []);
      })
      .catch(() => {
        if (!cancelled) setRecentStudioOperations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const selectedRegion = selClip && region?.clipId === selClip.id ? region : null;

  const deleteSelectedClipOrRegion = useCallback((source = 'manual') => {
    if (!selClip || !selTrack) return;
    if (selectedRegion) {
      const removed = removeRegion(selTrack.id, selClip.id, selectedRegion.a, selectedRegion.b);
      if (!removed) {
        setStatus('No selected region to delete.');
        return;
      }
      recordStudioOperation({
        source,
        type: 'delete_region',
        message: '',
        actions: [],
        result: {
          track_id: selTrack.id,
          clip_id: selClip.id,
          start: selectedRegion.a,
          end: selectedRegion.b,
        },
      });
      setSelected(null);
      setRegion(null);
      return;
    }

    removeClip(selTrack.id, selClip.id);
    recordStudioOperation({
      source,
      type: 'delete_clip',
      message: '',
      actions: [],
      result: { track_id: selTrack.id, clip_id: selClip.id },
    });
    setSelected(null);
    setRegion(null);
  }, [selClip, selTrack, selectedRegion, removeRegion, removeClip, recordStudioOperation]);

  const duplicateSelectedClipOrRegion = useCallback((source = 'manual') => {
    if (!selClip || !selTrack) return;
    if (selectedRegion) {
      const newId = duplicateRegion(selTrack.id, selClip.id, selectedRegion.a, selectedRegion.b);
      if (newId) setSelected({ trackId: selTrack.id, clipId: newId });
      recordStudioOperation({
        source,
        type: 'duplicate_region',
        message: '',
        actions: [],
        result: {
          track_id: selTrack.id,
          source_clip_id: selClip.id,
          clip_id: newId,
          start: selectedRegion.a,
          end: selectedRegion.b,
        },
      });
      setRegion(null);
      return;
    }

    duplicateClip(selTrack.id, selClip.id);
    recordStudioOperation({
      source,
      type: 'duplicate_clip',
      message: '',
      actions: [],
      result: { track_id: selTrack.id, clip_id: selClip.id },
    });
  }, [selClip, selTrack, selectedRegion, duplicateRegion, duplicateClip, recordStudioOperation]);

  // --- keyboard shortcuts ------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      // Undo/redo first: these carry modifiers and must not fall through to
      // the single-letter shortcuts below.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;

      if (e.code === 'Space') {
        // The piano roll handles its own Space; letting this one through too
        // played the clip and the whole timeline at the same time.
        if (midiEditorOpen) return;
        e.preventDefault();
        playing ? pause() : play();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelectedClipOrRegion();
      } else if (e.key === 's' || e.key === 'S') {
        if (selClip && selTrack) splitClip(selTrack.id, selClip.id, position);
      } else if (e.key === 'd' || e.key === 'D') {
        duplicateSelectedClipOrRegion();
      } else if (e.key === 'Escape') {
        setRegion(null);
      } else if (e.key === '+' || e.key === '=') {
        zoom(1);
      } else if (e.key === '-' || e.key === '_') {
        zoom(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    playing, pause, play, selClip, selTrack, midiEditorOpen,
    splitClip, position, undo, redo, deleteSelectedClipOrRegion, duplicateSelectedClipOrRegion,
  ]);

  useEffect(() => {
    if (!selected) {
      if (region) setRegion(null);
      return;
    }
    const track = tracks.find((t) => t.id === selected.trackId);
    const clip = track?.clips.find((c) => c.id === selected.clipId);
    if (!track || !clip) {
      setSelected(null);
      setRegion(null);
      return;
    }
    if (region && region.clipId !== selected.clipId) {
      setRegion(null);
    }
  }, [tracks, selected, region]);

  // Ctrl/Cmd + wheel to zoom around the cursor.
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1 : -1);
  };

  const onRulerDown = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    seek(xToTime(x));
  };

  const decodeResult = useCallback(
    async (result) => context().decodeAudioData(await (await fetch(result.audio_url)).arrayBuffer()),
    [context],
  );

  const regenClip = async ({ style, noise, bars }) => {
    if (!selClip || !selTrack) return;
    setBusy(true);
    setStatus(`Regenerating ${selTrack.name}…`);
    try {
      const result = await onGenerateStem({
        part: selTrack.kind,
        style,
        noise,
        bars,
        start_bar: selClip.startBar || 0,
        seed: Math.floor(Math.random() * 1e9),
      });
      const buffer = await decodeResult(result);
      replaceRegion(selTrack.id, selClip.id, selClip.start, selClip.start + selClip.duration, buffer, {
        prompt: style,
        seed: result.seed,
        backendUsed: result.backend_used,
        duration: result.duration || buffer.duration,
        startBar: selClip.startBar || 0,
        audioUrl: result.audio_url,
      });
    } catch (e) {
      setStatus(`Failed — ${e.message}`);
      setBusy(false);
      return;
    }
    setBusy(false);
    setStatus('');
  };

  const regenSection = async ({ style, noise }) => {
    if (!selClip || !selTrack || !region || region.clipId !== selClip.id) return;
    const { a, b } = region;
    const barsInSection = Math.max(1, Math.round((b - a) / secondsPerBar));
    const startBar = (selClip.startBar || 0) + Math.round((a - selClip.start) / secondsPerBar);
    setBusy(true);
    setStatus(`Regenerating bars ${startBar + 1}–${startBar + barsInSection}…`);
    try {
      const result = await onGenerateStem({
        part: selTrack.kind,
        style,
        noise,
        bars: barsInSection,
        start_bar: startBar,
        seed: Math.floor(Math.random() * 1e9),
      });
      const buffer = await decodeResult(result);
      replaceRegion(selTrack.id, selClip.id, a, b, buffer, {
        prompt: style,
        seed: result.seed,
        backendUsed: result.backend_used,
        duration: result.duration || buffer.duration,
        startBar,
        audioUrl: result.audio_url,
      });
      setRegion(null);
    } catch (e) {
      setStatus(`Failed — ${e.message}`);
      setBusy(false);
      return;
    }
    setBusy(false);
    setStatus('');
  };

  const onRecorded = async (blob) => {
    const buffer = await context().decodeAudioData(await blob.arrayBuffer());
    const n = tracks.filter((t) => t.kind === 'audio').length + 1;
    let upload = null;
    try {
      const { audioBufferToWav } = await import('../wav.js');
      upload = await onUploadAudio?.(audioBufferToWav(buffer), `recording-${n}`);
    } catch {
      upload = null;
    }
    addTrackWithClip(`Audio ${n}`, 'audio', buffer, {
      start: snap(position),
      duration: upload?.duration || buffer.duration,
      audioUrl: upload?.audio_url || null,
    });
  };

  // Import an audio file straight onto the timeline as a new clip.
  const onImport = async (file) => {
    if (!file) return;
    try {
      const buffer = await context().decodeAudioData(await file.arrayBuffer());
      const name = file.name.replace(/\.[^.]+$/, '');
      let upload = null;
      try {
        const { audioBufferToWav } = await import('../wav.js');
        upload = await onUploadAudio?.(audioBufferToWav(buffer), name || 'import');
      } catch {
        upload = null;
      }
      addTrackWithClip(name || 'Import', 'audio', buffer, {
        start: snap(position),
        duration: upload?.duration || buffer.duration,
        audioUrl: upload?.audio_url || null,
      });
    } catch (e) {
      setStatus(`Import failed — ${e.message}`);
    }
  };

  // Trim a clip edge; clamp to buffer bounds and a minimum length.
  const trimClip = (trackId, clip, side, t) => {
    const buf = getBuffer(clip.id);
    const bufDur = buf ? buf.duration : clip.offset + clip.duration;
    updateClip(trackId, clip.id, trimClipPatch(clip, side, t, bufDur, MIN_CLIP));
  };

  // Render a track's audio to a WAV blob, to post as a generation reference.
  const trackToWav = async (track) => {
    const { audioBufferToWav } = await import('../wav.js');
    const clip = track.clips[0];
    const buffer = clip && getBuffer(clip.id);
    if (!buffer) throw new Error(`${track.name} has no audio`);
    return audioBufferToWav(buffer, clip.offset, clip.duration);
  };

  // "New AI track": generate guided by another track instead of by a guide
  // synthesized from the chord grid.
  const generateReferenceTrack = async ({ referenceTrackId, prompt, noise, name }) => {
    const reference = tracks.find((t) => t.id === referenceTrackId);
    if (!reference) return;
    setBusy(true);
    setStatus(`Generating ${name} from ${reference.name}…`);
    try {
      const wav = await trackToWav(reference);
      const result = await onGenerateFromReference({
        referenceWav: wav,
        prompt,
        noise,
        name,
        seed: Math.floor(Math.random() * 1e9),
      });
      const buffer = await decodeResult(result);
      addTrackWithClip(name, 'audio', buffer, {
        start: reference.clips[0]?.start ?? 0,
        prompt,
        seed: result.seed,
        backendUsed: result.backend_used,
        duration: result.duration || buffer.duration,
        audioUrl: result.audio_url,
      });
      setStatus('');
    } catch (e) {
      setStatus(`Failed — ${e.message}`);
    }
    setBusy(false);
  };

  const buildStudioContext = () => ({
    bpm,
    key: keyName,
    mode,
    backend,
    seconds_per_bar: secondsPerBar,
    bar_numbering: '1-based; bar 1 starts at 0 seconds',
    playhead: position,
    duration,
    selected_track_id: selected?.trackId ?? null,
    selected_clip_id: selected?.clipId ?? null,
    selected_region:
      region && selected?.clipId === region.clipId
        ? {
            start: region.a,
            end: region.b,
            barStart: Math.round((region.a / secondsPerBar) * 4) / 4,
            barEnd: Math.round((region.b / secondsPerBar) * 4) / 4,
            bar_start_number: Math.floor(region.a / secondsPerBar) + 1,
            bar_end_number: Math.ceil(region.b / secondsPerBar),
            bar_start_position: Math.round((region.a / secondsPerBar + 1) * 4) / 4,
            bar_end_position: Math.round((region.b / secondsPerBar) * 4) / 4,
          }
        : null,
    tracks: tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      muted: track.muted,
      soloed: track.soloed,
      volume: track.volume,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        start: clip.start,
        end: clip.start + clip.duration,
        duration: clip.duration,
        offset: clip.offset,
        startBar: clip.startBar ?? 0,
        barStart: Math.round((clip.start / secondsPerBar) * 4) / 4,
        barEnd: Math.round(((clip.start + clip.duration) / secondsPerBar) * 4) / 4,
        bar_start_number: Math.floor(clip.start / secondsPerBar) + 1,
        bar_end_number: Math.ceil((clip.start + clip.duration) / secondsPerBar),
        bar_start_position: Math.round((clip.start / secondsPerBar + 1) * 4) / 4,
        bar_end_position: Math.round(((clip.start + clip.duration) / secondsPerBar) * 4) / 4,
        part: clip.part,
        prompt: clip.prompt,
        seed: clip.seed,
        backendUsed: clip.backendUsed,
      })),
    })),
    recent_actions: recentStudioOperations,
  });

  const normalizeClipRegion = (clip, range, options = {}) => {
    if (!clip) throw new Error('Select a clip first');
    const clipStart = clip.start;
    const clipEnd = clip.start + clip.duration;
    let start = Number(range?.start);
    let end = Number(range?.end);

    if ((!Number.isFinite(start) || !Number.isFinite(end) || start === end) && options.fallbackLastBars) {
      end = clipEnd;
      start = clipEnd - options.fallbackLastBars * secondsPerBar;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error('Select a non-empty clip region first');
    }

    const from = Math.max(clipStart, Math.min(start, end));
    const to = Math.min(clipEnd, Math.max(start, end));
    const snappedStart = Math.max(clipStart, Math.min(clipEnd, snapQuarterBar(from)));
    const snappedEnd = Math.max(clipStart, Math.min(clipEnd, snapQuarterBar(to)));
    if (snappedEnd - snappedStart < MIN_CLIP) {
      throw new Error('Selected region does not overlap the clip');
    }
    return { start: snappedStart, end: snappedEnd, duration: snappedEnd - snappedStart };
  };

  const clipRegionToWav = async (clip, range, options = {}) => {
    const buffer = getBuffer(clip.id);
    if (!buffer) throw new Error('Selected clip has no audio loaded');
    const { audioBufferToWav } = await import('../wav.js');
    const normalized = normalizeClipRegion(clip, range, options);
    return audioBufferToWav(
      buffer,
      clip.offset + (normalized.start - clip.start),
      normalized.duration,
    );
  };

  const resolveActionTargetStart = (action) => {
    if (Number.isFinite(Number(action.target_start))) {
      return Math.max(0, Number(action.target_start));
    }
    if (Number.isFinite(Number(action.target_bar))) {
      return Math.max(0, (Number(action.target_bar) - 1) * secondsPerBar);
    }
    throw new Error('No target time or bar provided');
  };

  const executeAgentAction = async (action, index, total) => {
    const targetTrack = action.track_id ? tracks.find((t) => t.id === action.track_id) : selTrack;
    const targetClip = targetTrack && action.clip_id
      ? targetTrack.clips.find((c) => c.id === action.clip_id)
      : action.track_id
        ? targetTrack?.clips[targetTrack.clips.length - 1]
        : selClip;

    if (action.type !== 'set_tempo_key' && (action.bpm || action.key || action.mode)) {
      setStatus('Setting tempo and key…');
      await onApplySettings({ bpm: action.bpm, key: action.key, mode: action.mode });
    }

    if (action.type === 'ask_clarification') {
      setStatus(action.reason || 'Select a clip or region first.');
      return;
    }

    if (action.type === 'set_tempo_key') {
      setStatus('Setting tempo and key…');
      await onApplySettings({ bpm: action.bpm, key: action.key, mode: action.mode });
      return;
    }

    if (action.type === 'split_clip') {
      if (!targetTrack || !targetClip) throw new Error('No clip selected to split');
      setStatus('Splitting clip…');
      splitClip(targetTrack.id, targetClip.id, position);
      recordStudioOperation({
        source: 'agent',
        type: 'split_clip',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: targetClip.id, at: position },
      });
      return;
    }

    if (action.type === 'move_clip') {
      if (!targetTrack || !targetClip) throw new Error('No clip selected to move');
      const targetStart = snapQuarterBar(resolveActionTargetStart(action));
      if (action.region) {
        const { start, end } = normalizeClipRegion(targetClip, action.region);
        setStatus('Moving selected region…');
        const newId = extractRegion(targetTrack.id, targetClip.id, start, end);
        moveClip(targetTrack.id, newId, targetStart);
        setSelected({ trackId: targetTrack.id, clipId: newId });
        setRegion(null);
        recordStudioOperation({
          source: 'agent',
          type: 'move_region',
          message: action.reason || '',
          actions: [action],
          result: { track_id: targetTrack.id, source_clip_id: targetClip.id, clip_id: newId, start, end, target_start: targetStart },
        });
        return;
      }
      setStatus('Moving clip…');
      patchClip(targetTrack.id, targetClip.id, { start: targetStart });
      recordStudioOperation({
        source: 'agent',
        type: 'move_clip',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: targetClip.id, target_start: targetStart },
      });
      return;
    }

    if (action.type === 'duplicate_clip') {
      if (!targetTrack || !targetClip) throw new Error('No clip selected to duplicate');
      if (action.region) {
        const { start, end } = normalizeClipRegion(targetClip, action.region);
        setStatus('Duplicating region…');
        const newId = duplicateRegion(targetTrack.id, targetClip.id, start, end);
        setSelected({ trackId: targetTrack.id, clipId: newId });
        setRegion(null);
        recordStudioOperation({
          source: 'agent',
          type: 'duplicate_region',
          message: action.reason || '',
          actions: [action],
          result: { track_id: targetTrack.id, source_clip_id: targetClip.id, clip_id: newId, start, end },
        });
        return;
      }
      setStatus('Duplicating clip…');
      duplicateClip(targetTrack.id, targetClip.id);
      recordStudioOperation({
        source: 'agent',
        type: 'duplicate_clip',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: targetClip.id },
      });
      return;
    }

    if (action.type === 'delete_clip') {
      if (!targetTrack || !targetClip) throw new Error('No clip selected to delete');
      if (action.region) {
        const { start, end } = normalizeClipRegion(targetClip, action.region);
        setStatus('Deleting region…');
        const removed = removeRegion(targetTrack.id, targetClip.id, start, end);
        if (!removed) throw new Error('Selected region could not be deleted');
        setSelected(null);
        setRegion(null);
        recordStudioOperation({
          source: 'agent',
          type: 'delete_region',
          message: action.reason || '',
          actions: [action],
          result: { track_id: targetTrack.id, clip_id: targetClip.id, start, end },
        });
        return;
      }
      setStatus('Deleting clip…');
      removeClip(targetTrack.id, targetClip.id);
      setSelected(null);
      setRegion(null);
      recordStudioOperation({
        source: 'agent',
        type: 'delete_clip',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: targetClip.id },
      });
      return;
    }

    if (action.type === 'delete_track') {
      if (!targetTrack) throw new Error('No track selected to delete');
      setStatus('Deleting track…');
      removeTrack(targetTrack.id);
      if (selected?.trackId === targetTrack.id) {
        setSelected(null);
        setRegion(null);
      }
      recordStudioOperation({
        source: 'agent',
        type: 'delete_track',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, name: targetTrack.name },
      });
      return;
    }

    if (action.type === 'extract_region') {
      if (!targetTrack || !targetClip || !action.region) throw new Error('Select a clip region first');
      const { start, end } = normalizeClipRegion(targetClip, action.region);
      setStatus('Extracting region…');
      const newId = extractRegion(targetTrack.id, targetClip.id, start, end);
      setSelected({ trackId: targetTrack.id, clipId: newId });
      setRegion(null);
      recordStudioOperation({
        source: 'agent',
        type: 'extract_region',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, source_clip_id: targetClip.id, clip_id: newId, start, end },
      });
      return;
    }

    if (action.type === 'crop_to_region') {
      if (!targetTrack || !targetClip || !action.region) throw new Error('Select a clip region first');
      const { start, end } = normalizeClipRegion(targetClip, action.region);
      setStatus('Cropping clip…');
      patchClip(targetTrack.id, targetClip.id, {
        start,
        offset: targetClip.offset + (start - targetClip.start),
        duration: end - start,
      });
      setRegion(null);
      recordStudioOperation({
        source: 'agent',
        type: 'crop_to_region',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: targetClip.id, start, end },
      });
      return;
    }

    if (action.type === 'fill_region') {
      if (!targetTrack || !action.region) throw new Error('Select a track and bar range to fill');
      const start = snapQuarterBar(Number(action.region.start));
      const end = snapQuarterBar(Number(action.region.end));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < MIN_CLIP) {
        throw new Error('Choose a non-empty bar range to fill');
      }
      const regionDuration = end - start;
      const quarterBars = Math.max(1, Math.round(regionDuration / quarterBarSec));
      const barsInSection = Math.max(1, Math.ceil(quarterBars / 4));
      const startBar = Math.max(0, Math.floor(start / secondsPerBar));
      const prompt = action.style || action.prompt || targetTrack.clips[targetTrack.clips.length - 1]?.prompt || `fill ${targetTrack.name}`;
      setStatus(`Filling ${targetTrack.name} (${index + 1}/${total})…`);
      const result = await onGenerateStem({
        part: targetTrack.kind,
        style: prompt,
        noise: action.noise,
        bars: barsInSection,
        start_bar: startBar,
        seed: Math.floor(Math.random() * 1e9),
      });
      const buffer = await decodeResult(result);
      const newClipId = addClip(targetTrack.id, buffer, {
        start,
        duration: regionDuration,
        part: targetTrack.kind,
        prompt,
        seed: result.seed,
        backendUsed: result.backend_used,
        audioUrl: result.audio_url,
        startBar,
      });
      setSelected({ trackId: targetTrack.id, clipId: newClipId });
      setRegion(null);
      recordStudioOperation({
        source: 'agent',
        type: 'fill_region',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: newClipId, start, end, audio_url: result.audio_url },
      });
      return;
    }

    if (action.type === 'regen_clip') {
      if (!targetTrack || !targetClip) throw new Error('No clip selected to regenerate');
      const bars = action.bars || Math.max(1, Math.round(targetClip.duration / secondsPerBar));
      setStatus(`Regenerating ${targetTrack.name}…`);
      const result = await onGenerateStem({
        part: targetTrack.kind,
        style: action.style || action.prompt || targetClip.prompt,
        noise: action.noise,
        bars,
        start_bar: targetClip.startBar || 0,
        seed: Math.floor(Math.random() * 1e9),
      });
      const buffer = await decodeResult(result);
      replaceRegion(targetTrack.id, targetClip.id, targetClip.start, targetClip.start + targetClip.duration, buffer, {
        prompt: action.style || action.prompt || targetClip.prompt,
        seed: result.seed,
        backendUsed: result.backend_used,
        duration: result.duration || buffer.duration,
        startBar: targetClip.startBar || 0,
        audioUrl: result.audio_url,
      });
      recordStudioOperation({
        source: 'agent',
        type: 'regen_clip',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: targetClip.id, audio_url: result.audio_url },
      });
      return;
    }

    if (action.type === 'regen_region') {
      if (!targetTrack || !targetClip || !action.region) throw new Error('Select a clip region first');
      const { start, end, duration: regionDuration } = normalizeClipRegion(targetClip, action.region);
      const quarterBars = Math.max(1, Math.round(regionDuration / quarterBarSec));
      const barsInSection = Math.max(1, Math.ceil(quarterBars / 4));
      const startBar = (targetClip.startBar || 0) + Math.floor((start - targetClip.start) / secondsPerBar);
      setStatus(`Regenerating selected region (${index + 1}/${total})…`);
      const result = await onGenerateStem({
        part: targetTrack.kind,
        style: action.style || action.prompt || targetClip.prompt,
        noise: action.noise,
        bars: barsInSection,
        start_bar: startBar,
        seed: Math.floor(Math.random() * 1e9),
      });
      const buffer = await decodeResult(result);
      replaceRegion(targetTrack.id, targetClip.id, start, end, buffer, {
        prompt: action.style || action.prompt || targetClip.prompt,
        seed: result.seed,
        backendUsed: result.backend_used,
        duration: regionDuration,
        startBar,
        audioUrl: result.audio_url,
      });
      setRegion(null);
      recordStudioOperation({
        source: 'agent',
        type: 'regen_region',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: targetClip.id, start, end, audio_url: result.audio_url },
      });
      return;
    }

    if (action.type === 'sa3_edit_region') {
      if (!targetTrack || !targetClip || !action.region) throw new Error('Select a clip region first');
      const normalized = normalizeClipRegion(targetClip, action.region);
      const prompt = action.prompt || action.style || `edit ${targetTrack.name}`;
      setStatus(`Editing selected audio with SA3 (${index + 1}/${total})…`);
      const wav = await clipRegionToWav(targetClip, normalized);
      const result = await onGenerateFromReference({
        referenceWav: wav,
        prompt,
        noise: action.noise ?? 0.75,
        name: `${targetTrack.name}-edit`,
        seed: Math.floor(Math.random() * 1e9),
      });
      const buffer = await decodeResult(result);
      replaceRegion(targetTrack.id, targetClip.id, normalized.start, normalized.end, buffer, {
        prompt,
        seed: result.seed,
        backendUsed: result.backend_used,
        duration: normalized.duration,
        audioUrl: result.audio_url,
      });
      setRegion(null);
      recordStudioOperation({
        source: 'agent',
        type: 'sa3_edit_region',
        message: action.reason || '',
        actions: [action],
        result: { track_id: targetTrack.id, clip_id: targetClip.id, start: normalized.start, end: normalized.end, audio_url: result.audio_url },
      });
      return;
    }

    if (action.type === 'extend_clip') {
      if (!targetTrack || !targetClip) throw new Error('No clip selected to extend');
      const bars = action.bars || 4;
      const reference = normalizeClipRegion(targetClip, null, { fallbackLastBars: bars });
      const prompt = action.prompt || action.style || `continue ${targetTrack.name} naturally`;
      setStatus(`Extending ${targetTrack.name} (${index + 1}/${total})…`);
      const wav = await clipRegionToWav(targetClip, reference);
      const result = await onGenerateFromReference({
        referenceWav: wav,
        prompt,
        noise: action.noise ?? 0.7,
        name: `${targetTrack.name}-extension`,
        seed: Math.floor(Math.random() * 1e9),
      });
      const buffer = await decodeResult(result);
      const newClipId = addClip(targetTrack.id, buffer, {
        start: targetClip.start + targetClip.duration,
        duration: result.duration || buffer.duration,
        part: targetClip.part || targetTrack.kind,
        prompt,
        seed: result.seed,
        backendUsed: result.backend_used,
        audioUrl: result.audio_url,
        startBar: (targetClip.startBar || 0) + Math.round(targetClip.duration / secondsPerBar),
      });
      setSelected({ trackId: targetTrack.id, clipId: newClipId });
      recordStudioOperation({
        source: 'agent',
        type: 'extend_clip',
        message: action.reason || '',
        actions: [action],
        result: {
          track_id: targetTrack.id,
          source_clip_id: targetClip.id,
          clip_id: newClipId,
          reference_start: reference.start,
          reference_end: reference.end,
          audio_url: result.audio_url,
        },
      });
      return;
    }

    if (action.type === 'compose_midi') {
      const label = action.name || action.part || 'MIDI';
      setStatus(`Writing ${label} (${index + 1}/${total})…`);
      await onComposeMidi({
        text: [action.name, action.instrument, action.style, action.prompt].filter(Boolean).join(', '),
        bars: action.bars || undefined,
        style: action.style || undefined,
      });
      return;
    }

    if (action.type === 'generate_track') {
      const part = action.part || 'free';
      const label = action.name || part;
      setStatus(`Generating ${label} (${index + 1}/${total})…`);
      const result = await onGenerateStem({
        part,
        style: action.style || action.prompt || undefined,
        name: action.name,
        instrument: action.instrument,
        production: action.production || undefined,
        bars: action.bars || undefined,
        voice_index: action.voice_index || 0,
        voice_count: action.voice_count || 1,
      });
      const buffer = await decodeResult(result);
      addTrackWithClip(label[0].toUpperCase() + label.slice(1), part, buffer, {
        audioUrl: result.audio_url,
        start: 0,
        part,
        prompt: action.style || action.prompt,
        seed: result.seed,
        backendUsed: result.backend_used,
        duration: result.duration || buffer.duration,
      });
      recordStudioOperation({
        source: 'agent',
        type: 'generate_track',
        message: action.reason || '',
        actions: [action],
        result: { name: action.name, part, audio_url: result.audio_url },
      });
      return;
    }

    throw new Error(`Unsupported agent action: ${action.type}`);
  };

  // Agentic bar: plan Studio actions, then execute them through the same
  // functions manual UI controls use.
  const runRequest = async (text) => {
    setBusy(true);
    setStatus('Planning…');

    let plan;
    try {
      plan = await apiClient.planAgentActions({
        message: text,
        sessionId,
        studioContext: buildStudioContext(),
      });
    } catch (e) {
      setStatus(`Could not plan — ${e.message}`);
      setBusy(false);
      return;
    }

    if (!plan.actions?.length) {
      setStatus(plan.notes || 'No action recognised.');
      setBusy(false);
      return;
    }

    try {
      const ROLE = {
        drums: 'rhythm', bass: 'rhythm', mix: 'rhythm',
        piano: 'comp', guitar: 'comp', harmony: 'comp',
        melody: 'lead', free: 'lead',
      };
      const roleCounts = {};
      const actions = plan.actions.map((action) => {
        if (action.type !== 'generate_track') return action;
        const role = ROLE[action.part] || 'lead';
        const voice_index = roleCounts[role] || 0;
        roleCounts[role] = voice_index + 1;
        return { ...action, voice_index };
      }).map((action) => (
        action.type === 'generate_track'
          ? { ...action, voice_count: roleCounts[ROLE[action.part] || 'lead'] || 1 }
          : action
      ));

      const generateActions = actions.filter((action) => action.type === 'generate_track');
      const otherActions = actions.filter((action) => action.type !== 'generate_track');

      if (generateActions.length > 1 && onGenerateSong) {
        setStatus(`Recording the band (${generateActions.length} parts)…`);
        const stems = await onGenerateSong({
          onProgress: setStatus,
          // The words the user actually typed — they lead the master prompt.
          description: text,
          tracks: generateActions.map((action) => ({
            part: action.part || 'free',
            name: action.name,
            instrument: action.instrument,
            voice_index: action.voice_index || 0,
            voice_count: action.voice_count || 1,
          })),
          style: generateActions
            .map((action) => action.style || action.prompt)
            .filter(Boolean)
            .join(', ') || undefined,
          production: generateActions.find((action) => action.production)?.production || undefined,
          bars: Math.max(...generateActions.map((action) => action.bars || 0)) || undefined,
        });
        for (const stem of stems) {
          const buffer = await decodeResult(stem);
          const part = stem.part || 'free';
          const label = stem.name || part;
          addTrackWithClip(label[0].toUpperCase() + label.slice(1), part, buffer, {
            audioUrl: stem.audio_url,
            start: 0,
            part,
            prompt: stem.prompt || '',
            seed: stem.seed,
            backendUsed: stem.backend_used,
            duration: stem.duration || buffer.duration,
          });
        }
        for (const [i, action] of otherActions.entries()) {
          await executeAgentAction(action, i, otherActions.length);
        }
      } else {
        for (const [i, action] of actions.entries()) {
          await executeAgentAction(action, i, actions.length);
        }
      }
      recordStudioOperation({
        source: 'agent',
        type: 'agent_actions',
        message: text,
        actions,
        result: { notes: plan.notes || '', interpreter: plan.interpreter || '' },
      });
      setStatus(plan.notes || '');
    } catch (e) {
      setStatus(`Failed — ${e.message}`);
    }
    setBusy(false);
  };

  // Loading an instrument into a slot generates its one-shots, after which
  // the part plays through the sampler. Notes are never regenerated, so
  // editing after this is instant.
  const loadInstrument = async (track, instrument) => {
    setTrackProp(track.id, 'instrument', instrument);
    if (!instrument) return;
    if (sampler.isLoaded(instrument)) return;
    setBusy(true);
    setStatus(`Loading ${instrument.name}…`);
    try {
      await sampler.load(instrument, { backend });
      setStatus('');
    } catch (e) {
      setStatus(`Could not load ${instrument.name} — ${e.message}`);
    }
    setBusy(false);
  };

  // Render a MIDI clip: its notes become the guide, the track's instrument
  // prompt becomes the sound. The notes stay on the clip afterwards, so it
  // can be edited and re-rendered.
  const renderMidiClip = async () => {
    if (!selClip || !selTrack) return;
    const instrument = selTrack.instrument;
    if (!instrument) {
      setStatus('Load an instrument into this track first.');
      return;
    }
    setBusy(true);
    setStatus(`Rendering ${selTrack.name}…`);
    try {
      const result = await onRenderMidi({
        notes: (selClip.notes || []).map(({ pitch, start, length, velocity }) => ({
          pitch, start, length, velocity,
        })),
        prompt: instrument.prompt,
        name: selTrack.name,
        bars: Math.max(1, Math.round((selClip.durationBeats || 8) / 4)),
      });
      const buffer = await decodeResult(result);
      attachBuffer(selTrack.id, selClip.id, buffer, {
        duration: result.duration || buffer.duration,
        seed: result.seed,
        backendUsed: result.backend_used,
        prompt: instrument.prompt,
      });
      setStatus('');
    } catch (e) {
      setStatus(`Failed — ${e.message}`);
    }
    setBusy(false);
  };

  const loopActive = !!loop;
  const toggleLoop = () => {
    if (loopActive) setLoop(null);
    else if (region) setLoop({ a: region.a, b: region.b });
  };

  return (
    <div className="studio">
      {/* Toolbar, grouped: transport | history | edit | ... | session | add.
          Separators mark the groups so the eye can skip to the one it wants
          instead of scanning one long undifferentiated row. */}
      <div className="studio-bar">
        <div className="bar-group">
          <button className="t-btn" onClick={playing ? pause : () => play()} title="Play/pause (Space)">
            {playing ? '❚❚' : '▶'}
          </button>
          <button className="t-btn" onClick={stop} title="Stop">
            ■
          </button>
          <button
            className={`t-btn${loopActive ? ' on' : ''}`}
            onClick={toggleLoop}
            disabled={!region && !loopActive}
            title="Loop the highlighted section"
          >
            ⟳
          </button>
          <span className="t-time">
            {fmt(position)} <span className="t-dim">/ {fmt(duration)}</span>
          </span>
        </div>

        <span className="bar-sep" />

        <div className="bar-group">
          <button className="t-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
            ↶
          </button>
          <button className="t-btn" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
            ↷
          </button>
        </div>

        <span className="bar-sep" />

        <div className="bar-group">
          <label className="snap-ctl" title="Snap clips to this grid division">
            snap
            <select value={snapId} onChange={(e) => setSnapId(e.target.value)}>
              {SNAPS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <div className="zoom-ctl">
            <button className="t-btn" onClick={() => zoom(-1)} title="Zoom out (−)">
              −
            </button>
            <button className="t-btn" onClick={() => zoom(1)} title="Zoom in (+)">
              +
            </button>
          </div>
        </div>

        <div className="bar-spacer" />

        <div className="bar-group">
          <label className="studio-field" title={detected ? 'detected from your recording' : ''}>
            bpm
            <input
              type="number"
              min="20"
              max="300"
              step="0.1"
              value={Math.round((bpm || 120) * 10) / 10}
              onChange={(e) => onBpm(Number(e.target.value))}
            />
          </label>
          <label className="studio-field">
            key
            <select value={keyName || 'C'} onChange={(e) => onKey(e.target.value)}>
              {NOTE_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select value={mode || 'major'} onChange={(e) => onMode(e.target.value)}>
              <option value="major">maj</option>
              <option value="minor">min</option>
            </select>
          </label>
        </div>

        <span className="bar-sep" />

        <div className="bar-group">
          <AddTrackMenu
            tracks={tracks}
            busy={busy}
            onEmpty={() => addTrack(`Audio ${tracks.length + 1}`, 'audio')}
            onRecord={onRecorded}
            onImport={onImport}
            onAiTrack={generateReferenceTrack}
            onMidi={() => {
              const n = tracks.filter((t) => t.kind === 'midi').length + 1;
              const { trackId, clipId } = addMidiTrack(`MIDI ${n}`, null, {
                start: 0,
                duration: secondsPerBar * 4,
                notes: [],
              });
              setSelected({ trackId, clipId });
            }}
          />
        </div>
      </div>


      <div className="arrangement">
        <div className="headers" style={{ width: HEADER_W }}>
          <div className="corner" style={{ height: RULER_H }} />
          {tracks.map((t) => (
            <TrackHeader
              key={t.id}
              track={t}
              height={LANE_H}
              instruments={instruments}
              sampler={sampler}
              onLoadInstrument={(i) => loadInstrument(t, i)}
              onProp={(p, v) => setTrackProp(t.id, p, v)}
              onRemove={() => {
                removeTrack(t.id);
                recordStudioOperation({
                  source: 'manual',
                  type: 'delete_track',
                  message: '',
                  actions: [],
                  result: { track_id: t.id, name: t.name },
                });
                if (selected?.trackId === t.id) {
                  setSelected(null);
                  setRegion(null);
                }
              }}
            />
          ))}
          {tracks.length === 0 && <div className="empty-h">no tracks</div>}
        </div>

        {tracks.length === 0 && (
          <div className="studio-empty">
            Empty timeline — Import an audio file, Record a clip, or generate
            backing from the Input view.
          </div>
        )}

        {tracks.length > 0 && (
        <div className="lanes-scroll" ref={scrollRef} onWheel={onWheel}>
          <div style={{ width: laneW }}>
            <Ruler
              width={laneW}
              height={RULER_H}
              secondsPerBar={secondsPerBar}
              pps={pps}
              loop={loop}
              onDown={onRulerDown}
            />
            <div className="lanes" style={{ position: 'relative' }}>
              {tracks.map((t) => (
                <Lane
                  key={t.id}
                  track={t}
                  height={LANE_H}
                  pps={pps}
                  secondsPerBar={secondsPerBar}
                  snapDiv={snapDiv}
                  snapSec={snapSec}
                  selectedClipId={selected?.clipId}
                  region={region}
                  getBuffer={getBuffer}
                  onSeek={(x) => seek(xToTime(x))}
                  onSelect={(clipId) => {
                    setSelected({ trackId: t.id, clipId });
                    setRegion(null);
                  }}
                  onMove={(clipId, s) => moveClip(t.id, clipId, s)}
                  onMoveEnd={(clipId, from, to) => {
                    recordStudioOperation({
                      source: 'manual',
                      type: 'move_clip',
                      message: '',
                      actions: [],
                      result: { track_id: t.id, clip_id: clipId, from, to },
                    });
                  }}
                  onTrim={(clip, side, tt) => trimClip(t.id, clip, side, tt)}
                  onTrimEnd={(clip, side, at) => {
                    recordStudioOperation({
                      source: 'manual',
                      type: 'trim_clip',
                      message: '',
                      actions: [],
                      result: { track_id: t.id, clip_id: clip.id, side, at },
                    });
                  }}
                  onBeginGesture={beginGesture}
                  onExtract={(clipId, a, b) => {
                    const newId = extractRegion(t.id, clipId, a, b);
                    setSelected({ trackId: t.id, clipId: newId });
                    setRegion(null);
                    recordStudioOperation({
                      source: 'manual',
                      type: 'extract_region',
                      message: '',
                      actions: [],
                      result: { track_id: t.id, source_clip_id: clipId, clip_id: newId, start: a, end: b },
                    });
                    return newId;
                  }}
                  onMoveById={(clipId, s) => moveClip(t.id, clipId, s)}
                  onRange={(clipId, a, b) => setRegion({ clipId, a, b })}
                />
              ))}
              <div
                className="playhead-line"
                style={{ left: timeToX(position), height: tracks.length * LANE_H }}
              />
            </div>
          </div>
        </div>
        )}
      </div>

      {selClip && selTrack && selTrack.kind === 'midi' && (
        <MidiEditor
          track={selTrack}
          clip={selClip}
          bpm={bpm}
          busy={busy}
          onBeginEdit={beginGesture}
          onNotesChange={(notes) => setClipNotes(selTrack.id, selClip.id, notes)}
          instruments={instruments}
          sampler={sampler}
          onLoadInstrument={(i) => loadInstrument(selTrack, i)}
          onLengthChange={(beats) => {
            const secondsPerBeat = 60 / (bpm || 100);
            updateClip(selTrack.id, selClip.id, {
              durationBeats: beats,
              duration: beats * secondsPerBeat,
            });
          }}
          onCreateInstrument={onCreateInstrument}
          onRender={renderMidiClip}
        />
      )}

      {selClip && selTrack && selTrack.kind !== 'midi' && (
        <ClipInspector
          track={selTrack}
          clip={selClip}
          region={region?.clipId === selClip.id ? region : null}
          secondsPerBar={secondsPerBar}
          busy={busy}
          buffer={getBuffer(selClip.id)}
          onRegenClip={regenClip}
          onRegenSection={regenSection}
          onSplit={() => {
            splitClip(selTrack.id, selClip.id, position);
            recordStudioOperation({
              source: 'manual',
              type: 'split_clip',
              message: '',
              actions: [],
              result: { track_id: selTrack.id, clip_id: selClip.id, at: position },
            });
          }}
          onDuplicate={() => {
            duplicateSelectedClipOrRegion();
          }}
          onDelete={() => {
            deleteSelectedClipOrRegion();
          }}
        />
      )}

      {/* Pinned to the bottom of the window, below the clip inspector.
          Full width because describing an arrangement in words is the
          primary way in for someone starting from nothing. */}
      <AskBar busy={busy} onRun={runRequest} status={status} />
    </div>
  );
}

// Describe an arrangement in words; parse it into parts + style and
// generate each one. The plan is shown before you commit, because a
// misread request costs a minute of generation.
function AskBar({ busy, onRun, status }) {
  const [text, setText] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (!busy && text.trim()) onRun(text);
  };

  return (
    <form className="askbar" onSubmit={submit}>
      <input
        className="ask-input"
        placeholder="Describe what you want — “bass, drums and piano, bossa nova”"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <button className="ask-go" disabled={busy || !text.trim()}>
        {busy ? '…' : 'Generate'}
      </button>
      <span className="ask-plan">
        {status || (text.trim() ? 'Ask the agent to plan and generate tracks' : '')}
      </span>
    </form>
  );
}

// "+ Track" with the four ways to get audio onto the timeline. The AI
// option needs a reference track, so it is disabled until one exists.
function AddTrackMenu({ tracks, busy, onEmpty, onRecord, onImport, onAiTrack, onMidi }) {
  const [open, setOpen] = useState(false);
  const [ai, setAi] = useState(false);
  const withAudio = tracks.filter((t) => t.clips.length > 0);

  return (
    <div className="add-menu">
      <button className="t-btn add-btn" onClick={() => setOpen((v) => !v)} disabled={busy}>
        + Track
      </button>

      {open && !ai && (
        <div className="menu-pop">
          <button
            onClick={() => {
              onEmpty();
              setOpen(false);
            }}
          >
            Empty audio track
          </button>
          <label className="menu-file">
            Import audio file…
            <input
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => {
                onImport(e.target.files[0]);
                setOpen(false);
              }}
            />
          </label>
          <button
            onClick={() => {
              onMidi();
              setOpen(false);
            }}
          >
            MIDI instrument track…
          </button>
          <button
            disabled={!withAudio.length}
            title={withAudio.length ? '' : 'needs an existing track to reference'}
            onClick={() => setAi(true)}
          >
            AI track from a reference…
          </button>
        </div>
      )}

      {open && ai && (
        <AiTrackForm
          tracks={withAudio}
          onCancel={() => {
            setAi(false);
            setOpen(false);
          }}
          onSubmit={(spec) => {
            onAiTrack(spec);
            setAi(false);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function AiTrackForm({ tracks, onCancel, onSubmit }) {
  const [referenceTrackId, setReference] = useState(tracks[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [noise, setNoise] = useState(0.8);
  const [name, setName] = useState('AI track');

  return (
    <form
      className="menu-pop ai-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (referenceTrackId && prompt.trim()) onSubmit({ referenceTrackId, prompt, noise, name });
      }}
    >
      <label>
        follow
        <select value={referenceTrackId} onChange={(e) => setReference(e.target.value)}>
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <textarea
        rows={2}
        placeholder="what should it sound like? e.g. “gritty analog synth bass”"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <label className="ai-noise">
        divergence <b>{noise.toFixed(2)}</b>
        <input
          type="range"
          min="0.6"
          max="0.95"
          step="0.05"
          value={noise}
          onChange={(e) => setNoise(Number(e.target.value))}
        />
      </label>
      <div className="ai-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="accent" disabled={!prompt.trim()}>
          Generate
        </button>
      </div>
    </form>
  );
}

function Lane({
  track,
  height,
  pps,
  secondsPerBar,
  snapDiv,
  snapSec,
  selectedClipId,
  region,
  getBuffer,
  onSeek,
  onSelect,
  onMove,
  onMoveEnd,
  onTrim,
  onTrimEnd,
  onBeginGesture,
  onExtract,
  onMoveById,
  onRange,
}) {
  const barPx = secondsPerBar * pps;
  const beatPx = barPx / (snapDiv >= 4 ? snapDiv : 4);
  // Grid: strong bar lines + lighter beat lines, drawn as a background.
  const grid = {
    backgroundImage: `repeating-linear-gradient(90deg, var(--line-strong) 0 1px, transparent 1px ${barPx}px), repeating-linear-gradient(90deg, rgba(0,0,0,0.06) 0 1px, transparent 1px ${beatPx}px)`,
  };
  return (
    <div
      className="lane"
      style={{ height, ...grid }}
      onMouseDown={(e) => {
        if (e.target.classList.contains('lane')) {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek(e.clientX - rect.left);
        }
      }}
    >
      {track.clips.map((c) => (
        <ClipView
          key={c.id}
          clip={c}
          buffer={getBuffer(c.id)}
          color={KIND_COLOR[track.kind] || '#c4d4d6'}
          pps={pps}
          height={height}
          snapSec={snapSec}
          selected={selectedClipId === c.id}
          region={region?.clipId === c.id ? region : null}
          onSelect={() => onSelect(c.id)}
          onBeginGesture={onBeginGesture}
          onMove={(s) => onMove(c.id, s)}
          onMoveEnd={(from, to) => onMoveEnd?.(c.id, from, to)}
          onMoveById={onMoveById}
          onTrim={(side, tt) => onTrim(c, side, tt)}
          onTrimEnd={(side, tt) => onTrimEnd?.(c, side, tt)}
          onExtract={(a, b) => onExtract(c.id, a, b)}
          onRange={(a, b) => onRange(c.id, a, b)}
        />
      ))}
    </div>
  );
}

function Ruler({ width, height, secondsPerBar, pps, loop, onDown }) {
  const bars = Math.ceil(width / (secondsPerBar * pps));
  const marks = [];
  for (let i = 0; i <= bars; i++) {
    const x = i * secondsPerBar * pps;
    marks.push(
      <div key={i} className="bar-mark" style={{ left: x }}>
        <span>{i + 1}</span>
      </div>,
    );
  }
  return (
    <div className="ruler" style={{ width, height }} onMouseDown={onDown}>
      {marks}
      {loop && (
        <div
          className="loop-band"
          style={{ left: loop.a * pps, width: (loop.b - loop.a) * pps }}
        />
      )}
    </div>
  );
}

function TrackHeader({ track, height, instruments, sampler, onLoadInstrument, onProp, onRemove }) {
  return (
    <div className="track-header" style={{ height }}>
      <span className="th-color" style={{ background: KIND_COLOR[track.kind] || '#c4d4d6' }} />
      <div className="th-body">
        <div className="th-top">
          <span className="th-name">{track.name}</span>
          <button className="th-x" title="delete track" onClick={onRemove}>
            ×
          </button>
        </div>
        {track.kind === 'midi' && (
          <InstrumentSlot
            compact
            instrument={track.instrument}
            instruments={instruments}
            loading={sampler?.loading}
            ready={sampler?.isLoaded(track.instrument)}
            onLoad={onLoadInstrument}
            onClear={() => onLoadInstrument(null)}
          />
        )}
        <div className="th-controls">
          <button className={`th-btn${track.muted ? ' on' : ''}`} onClick={() => onProp('muted', !track.muted)}>
            M
          </button>
          <button className={`th-btn solo${track.soloed ? ' on' : ''}`} onClick={() => onProp('soloed', !track.soloed)}>
            S
          </button>
          <input
            className="th-vol"
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={track.volume}
            onChange={(e) => onProp('volume', Number(e.target.value))}
          />
        </div>
      </div>
    </div>
  );
}

function ClipInspector({
  track,
  clip,
  region,
  secondsPerBar,
  busy,
  buffer,
  onRegenClip,
  onRegenSection,
  onSplit,
  onDuplicate,
  onDelete,
}) {
  const [prompt, setPrompt] = useState(clip.prompt || '');
  const [noise, setNoise] = useState(0.8);
  const [bars, setBars] = useState(Math.max(1, Math.round(clip.duration / secondsPerBar)));

  useEffect(() => {
    setPrompt(clip.prompt || '');
    setBars(Math.max(1, Math.round(clip.duration / secondsPerBar)));
  }, [clip, secondsPerBar]);

  const isPart = track.kind !== 'audio';
  const [shareLabel, setShareLabel] = useState('Share');
  const download = () => {
    import('../wav.js').then(({ audioBufferToWav }) => {
      if (!buffer) return;
      const wav = audioBufferToWav(buffer, clip.offset, clip.duration);
      const url = URL.createObjectURL(wav);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${track.name}.wav`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };
  // Share just this track. Native share sheet with the rendered WAV when the
  // browser supports sharing files; otherwise copy the clip's server URL to
  // the clipboard. Button label reports what happened, since the inspector
  // has no toast of its own.
  const flashLabel = (text) => {
    setShareLabel(text);
    window.setTimeout(() => setShareLabel('Share'), 2000);
  };
  const share = () => {
    import('../wav.js').then(async ({ audioBufferToWav }) => {
      if (!buffer) return;
      const wav = audioBufferToWav(buffer, clip.offset, clip.duration);
      const file = new File([wav], `${track.name}.wav`, { type: 'audio/wav' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: track.name });
        } catch {
          /* user dismissed the share sheet */
        }
        return;
      }
      if (clip.audioUrl) {
        const url = new URL(clip.audioUrl, window.location.origin).href;
        try {
          await navigator.clipboard.writeText(url);
          flashLabel('Link copied');
          return;
        } catch {
          /* clipboard blocked — fall through to a download */
        }
      }
      download();
      flashLabel('Downloaded');
    });
  };
  const regionBars = region ? Math.max(1, Math.round((region.b - region.a) / secondsPerBar)) : 0;
  const clipStartBar = Math.round((clip.start / secondsPerBar) * 4) / 4;
  const clipEndBar = Math.round(((clip.start + clip.duration) / secondsPerBar) * 4) / 4;
  const regionStartBar = region ? Math.round((region.a / secondsPerBar) * 4) / 4 : null;
  const regionEndBar = region ? Math.round((region.b / secondsPerBar) * 4) / 4 : null;

  return (
    <div className="inspector">
      <div className="insp-title">
        <span className="dot" style={{ background: KIND_COLOR[track.kind] || '#c4d4d6' }} />
        {track.name}
        <span className="insp-meta">
          {fmt(clip.start)}-{fmt(clip.start + clip.duration)} · bars {clipStartBar}-{clipEndBar}
        </span>
        {region && (
          <span className="insp-meta">
            selection {fmt(region.a)}-{fmt(region.b)} · bars {regionStartBar}-{regionEndBar}
          </span>
        )}
        {clip.seed != null && <span className="insp-meta">seed {clip.seed}</span>}
        {clip.backendUsed && <span className="insp-meta">{clip.backendUsed}</span>}
      </div>

      {isPart && (
        <div className="insp-row">
          <input
            className="insp-prompt"
            placeholder="prompt — style for this part"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <label className="insp-field">
            divergence <b>{noise.toFixed(2)}</b>
            <input type="range" min="0.6" max="0.95" step="0.05" value={noise} onChange={(e) => setNoise(Number(e.target.value))} />
          </label>
          <label className="insp-field">
            bars
            <input className="insp-bars" type="number" min="1" max="128" value={bars} onChange={(e) => setBars(Number(e.target.value))} />
          </label>
          <button className="i-btn" disabled={busy} onClick={() => onRegenClip({ style: prompt, noise, bars })}>
            {busy ? '…' : 'Regen clip'}
          </button>
          <button
            className="i-btn accent"
            disabled={busy || !region}
            title={region ? `bars ${regionBars}` : "drag across a clip waveform to select a section"}
            onClick={() => onRegenSection({ style: prompt, noise })}
          >
            {region ? `Regen section (${regionBars})` : 'Regen section'}
          </button>
        </div>
      )}

      <div className="insp-row">
        <button className="i-btn" onClick={onSplit} title="S">
          Split at playhead
        </button>
        <button className="i-btn" onClick={onDuplicate} title="D">
          {region ? 'Duplicate region' : 'Duplicate clip'}
        </button>
        <button className="i-btn" onClick={download}>
          Download WAV
        </button>
        <button className="i-btn" onClick={share}>
          {shareLabel}
        </button>
        <button className="i-btn danger" onClick={onDelete} title="Delete/Backspace">
          {region ? 'Delete region' : 'Delete clip'}
        </button>
      </div>
    </div>
  );
}
