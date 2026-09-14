import { useEffect, useMemo, useRef } from 'react';

// One clip: a block with a title strip, waveform, edge trim handles, and an
// optional highlighted section. What a drag does depends on where it starts,
// the way Ableton does it — no modal tool to remember:
//
//   title strip   drag to reposition the clip (snapped)
//   waveform      drag to highlight a section; drag again *inside* that
//                 highlight to cut it out as its own clip and move it
//   edges         drag to trim
//
// The second gesture is the split: nothing is ever cut by a bare click, so a
// misplaced click cannot silently chop a clip in half. You choose the region
// first, see it highlighted, and only then pull it out.
export default function ClipView({
  clip,
  buffer,
  color,
  pps,
  height,
  snapSec,
  selected,
  region,
  onSelect,
  onBeginGesture,
  onMove,
  onMoveEnd,
  onMoveById,
  onTrim,
  onTrimEnd,
  onExtract,
  onRange,
}) {
  const canvasRef = useRef(null);
  const width = Math.max(6, clip.duration * pps);
  const left = clip.start * pps;
  const TITLE_H = 15;
  const snap = (t) => (snapSec > 0 ? Math.round(t / snapSec) * snapSec : t);

  // A MIDI clip shows its notes; an audio clip shows its waveform. Both
  // draw to the same canvas, so a clip that has been rendered still reads
  // as the notes that produced it rather than switching representation.
  const isMidi = Array.isArray(clip.notes);

  const peaks = useMemo(() => {
    if (isMidi || !buffer) return null;
    const sr = buffer.sampleRate;
    const data = buffer.getChannelData(0);
    const startF = Math.floor(clip.offset * sr);
    const frames = Math.floor(clip.duration * sr);
    const cols = Math.max(1, Math.floor(width));
    const step = Math.max(1, Math.floor(frames / cols));
    const out = new Float32Array(cols * 2);
    for (let x = 0; x < cols; x++) {
      let min = 1;
      let max = -1;
      const s = startF + x * step;
      for (let i = 0; i < step; i++) {
        const v = data[s + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      out[x * 2] = min;
      out[x * 2 + 1] = max;
    }
    return out;
  }, [isMidi, buffer, clip.offset, clip.duration, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const h = height - TITLE_H;

    if (isMidi) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);

      const notes = clip.notes || [];
      if (!notes.length) return;
      // Scale to the notes actually present, so a two-octave part fills
      // the lane instead of sitting as a thin band in the middle.
      const low = Math.min(...notes.map((n) => n.pitch)) - 1;
      const high = Math.max(...notes.map((n) => n.pitch)) + 1;
      const span = Math.max(4, high - low);
      const beats = Math.max(1, clip.durationBeats || notes.reduce((m, n) => Math.max(m, n.start + n.length), 0));

      ctx.fillStyle = '#3b3f52';
      notes.forEach((n) => {
        const x = (n.start / beats) * width;
        const w = Math.max(2, (n.length / beats) * width);
        const y = h - ((n.pitch - low) / span) * h;
        ctx.fillRect(x, y - 2, w, 3);
      });
      return;
    }

    if (!peaks) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const mid = h / 2;
    ctx.fillStyle = '#1a1a1a';
    const cols = peaks.length / 2;
    for (let x = 0; x < cols; x++) {
      const y1 = mid - peaks[x * 2 + 1] * (mid - 1);
      const y2 = mid - peaks[x * 2] * (mid - 1);
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }, [isMidi, clip.notes, clip.durationBeats, peaks, width, height]);

  // Timeline seconds from a pointer event, relative to the lane.
  const eventTime = (ev, laneLeft) => (ev.clientX - laneLeft) / pps;

  // Attach a drag that runs `onDrag(deltaSeconds)` until pointer-up.
  const dragFrom = (e, onDrag, onEnd) => {
    const startX = e.clientX;
    const move = (ev) => onDrag((ev.clientX - startX) / pps);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const withinRegion = (t) => region && t >= region.a && t <= region.b;

  // Grabbing the title strip moves the whole clip. Nothing else does, so a
  // stray drag across the waveform can never shift a part off the beat.
  const titleDown = (e) => {
    e.stopPropagation();
    onSelect();
    onBeginGesture();
    const origStart = clip.start;
    let latestStart = origStart;
    dragFrom(
      e,
      (delta) => {
        latestStart = snap(origStart + delta);
        onMove(latestStart);
      },
      () => {
        if (latestStart !== origStart) onMoveEnd?.(origStart, latestStart);
      },
    );
  };

  // Dragging on the waveform highlights a section; dragging from inside an
  // existing highlight pulls that section out as its own clip and moves it.
  // The head and tail stay put.
  const bodyDown = (e) => {
    e.stopPropagation();
    onSelect();
    const laneLeft = e.currentTarget.parentElement.parentElement.getBoundingClientRect().left;
    const startT = eventTime(e, laneLeft);

    if (withinRegion(startT)) {
      const from = region.a;
      const extractedId = onExtract(region.a, region.b);
      if (extractedId) dragFrom(e, (delta) => onMoveById(extractedId, snap(from + delta)));
      return;
    }

    dragFrom(e, (delta) => {
      const cur = startT + delta;
      const a = Math.max(clip.start, snap(Math.min(startT, cur)));
      const b = Math.min(clip.start + clip.duration, snap(Math.max(startT, cur)));
      onRange(a, b);
    });
  };

  const trimDown = (side) => (e) => {
    e.stopPropagation();
    onSelect();
    onBeginGesture();
    const laneLeft = e.currentTarget.parentElement.parentElement.getBoundingClientRect().left;
    let latestT = null;
    const move = (ev) => {
      const t = snap(eventTime(ev, laneLeft));
      latestT = t;
      onTrim(side, t);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (latestT != null) onTrimEnd?.(side, latestT);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className={`clip${selected ? ' selected' : ''}`} style={{ left, width, height }}>
      <div
        className="clip-title"
        style={{ height: TITLE_H, background: color }}
        title="drag to move this clip"
        onPointerDown={titleDown}
      >
        {clip.part || (isMidi ? 'midi' : 'audio')}
      </div>
      <canvas
        ref={canvasRef}
        className="clip-body"
        style={{ width, height: height - TITLE_H, display: 'block' }}
        onPointerDown={bodyDown}
      />
      {region && (
        <div
          className="clip-region"
          title="drag to pull this section out as its own clip"
          style={{ left: (region.a - clip.start) * pps, width: (region.b - region.a) * pps }}
          onPointerDown={bodyDown}
        >
          <span className="region-grip" />
        </div>
      )}
      <span className="trim-handle left" onPointerDown={trimDown('left')} />
      <span className="trim-handle right" onPointerDown={trimDown('right')} />
    </div>
  );
}
