export const MIN_CLIP_SECONDS = 0.05;

export function clipEnd(clip) {
  return clip.start + clip.duration;
}

export function clampMoveStart(newStart) {
  return Math.max(0, newStart);
}

export function trimClipPatch(clip, side, time, bufferDuration, minClip = MIN_CLIP_SECONDS) {
  const bufDur = Number.isFinite(bufferDuration) ? bufferDuration : clip.offset + clip.duration;
  if (side === 'left') {
    const minStart = clip.start - clip.offset;
    const maxStart = clip.start + clip.duration - minClip;
    const start = Math.max(minStart, Math.min(time, maxStart));
    const delta = start - clip.start;
    return {
      start,
      offset: clip.offset + delta,
      duration: clip.duration - delta,
    };
  }

  const end = Math.max(clip.start + minClip, time);
  return { duration: end - clip.start };
}

export function normalizeRegion(clip, a, b, minClip = 0.02) {
  const from = Math.max(clip.start, Math.min(a, b));
  const to = Math.min(clipEnd(clip), Math.max(a, b));
  if (to - from < minClip) return null;
  return { start: from, end: to, duration: to - from };
}

export function splitClipPieces(clip, atTime, makeId, minEdge = 0.02) {
  if (atTime <= clip.start + minEdge || atTime >= clipEnd(clip) - minEdge) {
    return null;
  }
  const leftDuration = atTime - clip.start;
  return {
    left: { ...clip, duration: leftDuration },
    right: {
      ...clip,
      id: makeId(),
      start: atTime,
      offset: clip.offset + leftDuration,
      duration: clip.duration - leftDuration,
    },
  };
}

export function extractRegionPieces(clip, a, b, makeId, minEdge = 0.02, middleId = makeId()) {
  const region = normalizeRegion(clip, a, b, minEdge);
  if (!region) return null;

  const pieces = [];
  if (region.start > clip.start + minEdge) {
    pieces.push({
      ...clip,
      id: makeId(),
      duration: region.start - clip.start,
    });
  }

  pieces.push({
    ...clip,
    id: middleId,
    start: region.start,
    offset: clip.offset + (region.start - clip.start),
    duration: region.duration,
  });

  if (region.end < clipEnd(clip) - minEdge) {
    pieces.push({
      ...clip,
      id: makeId(),
      start: region.end,
      offset: clip.offset + (region.end - clip.start),
      duration: clipEnd(clip) - region.end,
    });
  }

  return { middleId, pieces, region };
}

export function replacementPieces(clip, regStart, regEnd, replacement, makeId, minEdge = 0.02) {
  const region = normalizeRegion(clip, regStart, regEnd, minEdge);
  if (!region) return null;

  const pieces = [];
  if (region.start > clip.start + minEdge) {
    pieces.push({
      ...clip,
      id: makeId(),
      start: clip.start,
      offset: clip.offset,
      duration: region.start - clip.start,
    });
  }

  const replacementId = makeId();
  pieces.push({
    ...replacement,
    id: replacementId,
    start: region.start,
    offset: 0,
    duration: replacement.duration,
  });

  if (region.end < clipEnd(clip) - minEdge) {
    pieces.push({
      ...clip,
      id: makeId(),
      start: region.end,
      offset: clip.offset + (region.end - clip.start),
      duration: clipEnd(clip) - region.end,
    });
  }

  return { pieces, region, replacementId };
}

export function duplicateClipPiece(clip, makeId) {
  return { ...clip, id: makeId(), start: clip.start + clip.duration };
}

export function deleteRegionPieces(clip, a, b, makeId, minEdge = 0.02) {
  const region = normalizeRegion(clip, a, b, minEdge);
  if (!region) return null;

  const pieces = [];
  if (region.start > clip.start + minEdge) {
    pieces.push({
      ...clip,
      id: makeId(),
      duration: region.start - clip.start,
    });
  }
  if (region.end < clipEnd(clip) - minEdge) {
    pieces.push({
      ...clip,
      id: makeId(),
      start: region.end,
      offset: clip.offset + (region.end - clip.start),
      duration: clipEnd(clip) - region.end,
    });
  }
  return { pieces, region };
}

export function duplicateRegionPiece(clip, a, b, makeId, minEdge = 0.02) {
  const region = normalizeRegion(clip, a, b, minEdge);
  if (!region) return null;
  return {
    ...clip,
    id: makeId(),
    start: clipEnd(clip),
    offset: clip.offset + (region.start - clip.start),
    duration: region.duration,
  };
}
