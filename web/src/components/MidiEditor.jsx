import { useCallback, useEffect, useRef, useState } from 'react';
import PianoRoll from './PianoRoll.jsx';
import InstrumentSlot from './InstrumentSlot.jsx';
import { useMidiInput } from '../useMidiInput.js';

// The piano roll, docked at the bottom of the studio for whichever MIDI
// clip is selected. Notes play through the track's sampled instrument, so
// what you hear while editing is what the timeline will play.

let counter = 0;
const uid = () => `n-${++counter}`;

const SNAPS = [
  { id: 'bar', label: 'Bar', value: 4 },
  { id: '1/2', label: '1/2', value: 2 },
  { id: '1/4', label: '1/4', value: 1 },
  { id: '1/8', label: '1/8', value: 0.5 },
  { id: '1/16', label: '1/16', value: 0.25 },
  { id: '1/32', label: '1/32', value: 0.125 },
  { id: 'off', label: 'Off', value: 0.0001 },
];

export default function MidiEditor({
  track,
  clip,
  bpm,
  busy,
  onNotesChange,
  onBeginEdit,
  onRender,
  onLengthChange,
  instruments,
  sampler,
  onLoadInstrument,
}) {
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [snapId, setSnapId] = useState('1/16');
  const [countIn, setCountIn] = useState(true);

  const beatsPerBar = 4;
  const secondsPerBeat = 60 / (bpm || 100);
  const totalBeats = clip.durationBeats || 16;
  const bars = Math.max(1, Math.round(totalBeats / beatsPerBar));
  const snap = SNAPS.find((s) => s.id === snapId)?.value ?? 0.25;

  const notes = clip.notes || [];
  // Read through a ref inside callbacks: a note recorded mid-take must
  // append to the current list, not the one captured when recording began.
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // Where the transport started, and when, so position comes from the
  // clock rather than being accumulated frame by frame (which drifts).
  const originRef = useRef(0);
  const startedAtRef = useRef(0);
  const voicesRef = useRef(new Map());
  const scheduledRef = useRef([]);
  const ctxRef = useRef(null);

  const audio = useCallback(() => {
    if (sampler?.context) return sampler.context();
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, [sampler]);

  const hasInstrument = !!(track.instrument && sampler?.isLoaded(track.instrument));

  // --- monitoring --------------------------------------------------------

  const noteOn = useCallback(
    ({ pitch, velocity = 90 }) => {
      voicesRef.current.get(pitch)?.stop();

      if (hasInstrument) {
        const voice = sampler.noteOn(track.instrument, pitch, { gain: velocity / 127 });
        if (voice) {
          voicesRef.current.set(pitch, voice);
          return;
        }
      }

      // Plain tone, so the keyboard still responds before an instrument is
      // loaded or while one is being sampled.
      const ctx = audio();
      ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime((velocity / 127) * 0.2, ctx.currentTime + 0.005);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      voicesRef.current.set(pitch, {
        stop() {
          const now = ctx.currentTime;
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0.0001, now + 0.1);
          osc.stop(now + 0.12);
        },
      });
    },
    [hasInstrument, sampler, track.instrument, audio],
  );

  const noteOff = useCallback(({ pitch }) => {
    voicesRef.current.get(pitch)?.stop();
    voicesRef.current.delete(pitch);
  }, []);

  // A short audition when a note is added or dragged to a new pitch.
  const preview = useCallback(
    (pitch, velocity = 90) => {
      if (hasInstrument) {
        const ctx = audio();
        ctx.resume();
        sampler.play(track.instrument, pitch, ctx.currentTime, 0.4, { gain: velocity / 127 });
        return;
      }
      noteOn({ pitch, velocity });
      window.setTimeout(() => noteOff({ pitch }), 200);
    },
    [hasInstrument, sampler, track.instrument, audio, noteOn, noteOff],
  );

  // A played note lands here on release, when its length is finally known.
  // It is placed relative to where the playhead was when recording began,
  // so a part can be built up a phrase at a time from anywhere in the clip.
  const onPlayedNote = useCallback(
    ({ pitch, velocity, startedAt, endedAt }) => {
      if (!recording) return;
      const snapTo = (b) => Math.max(0, Math.round(b / snap) * snap);
      const offset = (startedAt - startedAtRef.current) / 1000 / secondsPerBeat;
      const start = snapTo(originRef.current + Math.max(0, offset));
      const length = Math.max(snap, snapTo((endedAt - startedAt) / 1000 / secondsPerBeat));
      onBeginEdit?.();
      onNotesChange([...notesRef.current, { id: uid(), pitch, velocity, start, length }]);
    },
    [recording, secondsPerBeat, snap, onBeginEdit, onNotesChange],
  );

  const { devices, active, error, panic } = useMidiInput({
    onNote: onPlayedNote,
    onNoteOn: noteOn,
    onNoteOff: noteOff,
  });

  // --- transport ---------------------------------------------------------

  const stopAll = useCallback(() => {
    scheduledRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* already finished */
      }
    });
    scheduledRef.current = [];
    voicesRef.current.forEach((v) => v.stop());
    voicesRef.current.clear();
  }, []);

  const stop = useCallback(() => {
    setPlaying(false);
    setRecording(false);
    panic();
    stopAll();
  }, [panic, stopAll]);

  // One effect drives play and record alike: they are the same transport,
  // differing only in whether incoming notes are captured.
  useEffect(() => {
    if (!playing && !recording) return undefined;

    const ctx = audio();
    ctx.resume();
    const lead = recording && countIn ? beatsPerBar * secondsPerBeat : 0;
    const from = originRef.current;
    startedAtRef.current = performance.now() + lead * 1000;
    const audioStart = ctx.currentTime + lead;

    // Play the notes already there, so recording is played *along with*
    // the part rather than into silence.
    if (hasInstrument) {
      notesRef.current.forEach((n) => {
        const at = (n.start - from) * secondsPerBeat;
        const length = n.length * secondsPerBeat;
        if (at + length <= 0) return;
        const source = sampler.play(
          track.instrument,
          n.pitch,
          audioStart + Math.max(0, at),
          length + Math.min(0, at),
          { gain: (n.velocity ?? 90) / 127 },
        );
        if (source) scheduledRef.current.push(source);
      });
    }

    let frame;
    const tick = () => {
      const elapsed = (performance.now() - startedAtRef.current) / 1000 / secondsPerBeat;
      const position = from + Math.max(0, elapsed);
      if (position >= totalBeats) {
        stop();
        setPlayhead(from);
        return;
      }
      setPlayhead(position);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      stopAll();
    };
    // The start position is read once on purpose: it should not restart
    // the transport if the playhead state changes mid-take.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, recording]);

  // Release anything sounding when the editor closes or the track changes.
  useEffect(() => () => stopAll(), [track.id, stopAll]);

  // Space toggles playback, as everywhere else in the app.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (playing || recording) stop();
      else {
        stopAll();
        setPlaying(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, recording, stop, stopAll]);

  const scrub = (beat) => {
    const clamped = Math.max(0, Math.min(beat, totalBeats));
    originRef.current = clamped;
    setPlayhead(clamped);
  };

  const position = `${Math.floor(playhead / beatsPerBar) + 1}.${
    Math.floor(playhead % beatsPerBar) + 1
  }`;

  return (
    <div className="midi-editor">
      <div className="midi-bar">
        <span className="midi-title">{track.name}</span>

        <div className="bar-group">
          <button
            className="t-btn"
            onClick={() => {
              if (playing) return stop();
              stopAll();
              setPlaying(true);
            }}
            title="Play from the playhead (Space)"
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <button
            className={`t-btn${recording ? ' rec' : ''}`}
            onClick={() => {
              if (recording) return stop();
              stopAll();
              setRecording(true);
            }}
            title="Record from the playhead"
          >
            ●
          </button>
          <button className="t-btn" onClick={stop} title="Stop">
            ■
          </button>
          <span className="midi-pos">{position}</span>
        </div>

        <span className="bar-sep" />

        <label className="snap-ctl" title="Grid that notes snap to">
          snap
          <select value={snapId} onChange={(e) => setSnapId(e.target.value)}>
            {SNAPS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="snap-ctl" title="Clip length in bars">
          bars
          <input
            className="midi-bars"
            type="number"
            min="1"
            max="64"
            value={bars}
            onChange={(e) => {
              onBeginEdit?.();
              onLengthChange?.(Math.max(1, Math.min(64, Number(e.target.value) || 1)) * beatsPerBar);
            }}
          />
        </label>

        <label className="midi-check" title="One bar of lead-in before recording starts">
          <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} />
          count-in
        </label>

        <span className="bar-sep" />

        <InstrumentSlot
          instrument={track.instrument}
          instruments={instruments}
          loading={sampler?.loading}
          ready={hasInstrument}
          onLoad={onLoadInstrument}
          onClear={() => onLoadInstrument(null)}
        />

        <button
          className="t-btn"
          disabled={!notes.length}
          onClick={() => {
            onBeginEdit?.();
            onNotesChange([]);
          }}
        >
          Clear
        </button>

        {clip.midiUrl && <a className="t-btn" href={clip.midiUrl} download={`${track.name}.mid`}>Download MIDI</a>}

        <button
          className="t-btn"
          disabled={busy || !notes.length || !track.instrument}
          onClick={onRender}
          title="Bake this part to audio — the sampler already plays it live"
        >
          {busy ? '…' : 'Bounce'}
        </button>

        <span className="midi-devices">
          {/* Silence here is nearly always an empty slot, so say so rather
              than leaving the user wondering whether anything generated. */}
          {!track.instrument ? (
            <b className="midi-warn">load an instrument to hear this</b>
          ) : !hasInstrument ? (
            <b className="midi-warn">
              {sampler?.loading === track.instrument.id ? 'loading…' : 'instrument not loaded'}
            </b>
          ) : (
            error || (devices.length ? devices.map((d) => d.name).join(', ') : 'no controller')
          )}
          {' · '}
          {notes.length} notes
        </span>
      </div>

      <PianoRoll
        notes={notes}
        onChange={onNotesChange}
        onBeginEdit={onBeginEdit}
        bars={bars}
        beatsPerBar={beatsPerBar}
        snap={snap}
        activePitches={active}
        playhead={playhead}
        onScrub={scrub}
        onPreview={preview}
      />
    </div>
  );
}
