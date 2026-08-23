import assert from 'node:assert/strict';
import {
  clampMoveStart,
  deleteRegionPieces,
  duplicateClipPiece,
  duplicateRegionPiece,
  extractRegionPieces,
  replacementPieces,
  splitClipPieces,
  trimClipPatch,
} from './timelineOps.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

let n = 0;
const id = () => `id-${++n}`;
const clip = {
  id: 'clip-1',
  start: 10,
  offset: 2,
  duration: 8,
  part: 'piano',
  prompt: 'sad piano',
  seed: 12,
  backendUsed: 'api',
  startBar: 4,
  audioUrl: '/audio/original.wav',
};

assert.equal(clampMoveStart(-4), 0);
assert.equal(clampMoveStart(3), 3);

assert.deepEqual(trimClipPatch(clip, 'left', 11.5, 12), {
  start: 11.5,
  offset: 3.5,
  duration: 6.5,
});
assert.deepEqual(trimClipPatch(clip, 'left', 0, 12), {
  start: 8,
  offset: 0,
  duration: 10,
});
assert.deepEqual(trimClipPatch(clip, 'right', 40, 12), {
  duration: 30,
});
near(trimClipPatch(clip, 'right', 10.01, 12).duration, 0.05);

const split = splitClipPieces(clip, 13, id);
assert.equal(split.left.start, 10);
assert.equal(split.left.duration, 3);
assert.equal(split.right.start, 13);
assert.equal(split.right.offset, 5);
assert.equal(split.right.duration, 5);
assert.equal(splitClipPieces(clip, 10.01, id), null);

const extracted = extractRegionPieces(clip, 12, 15, id, 0.02, 'middle');
assert.equal(extracted.middleId, 'middle');
assert.deepEqual(extracted.pieces.map((p) => [p.id, p.start, p.offset, p.duration]), [
  ['id-2', 10, 2, 2],
  ['middle', 12, 4, 3],
  ['id-3', 15, 7, 3],
]);
assert.equal(extractRegionPieces(clip, 1, 2, id), null);

const replaced = replacementPieces(
  clip,
  12.25,
  14.5,
  {
    duration: 2.25,
    part: 'piano',
    prompt: 'new take',
    seed: 99,
    backendUsed: 'api',
    startBar: 5,
    audioUrl: '/audio/new.wav',
  },
  id,
);
assert.equal(replaced.region.start, 12.25);
assert.equal(replaced.region.end, 14.5);
assert.equal(replaced.pieces[1].id, replaced.replacementId);
assert.deepEqual(replaced.pieces.map((p) => [p.start, p.offset, p.duration]), [
  [10, 2, 2.25],
  [12.25, 0, 2.25],
  [14.5, 6.5, 3.5],
]);
assert.equal(replacementPieces(clip, 20, 21, { duration: 1 }, id), null);

const copy = duplicateClipPiece(clip, id);
assert.equal(copy.start, 18);
assert.equal(copy.duration, clip.duration);
assert.notEqual(copy.id, clip.id);

const deleted = deleteRegionPieces(clip, 12, 15, id);
assert.deepEqual(deleted.pieces.map((p) => [p.start, p.offset, p.duration]), [
  [10, 2, 2],
  [15, 7, 3],
]);
assert.deepEqual(deleteRegionPieces(clip, 10, 18, id).pieces, []);
assert.equal(deleteRegionPieces(clip, 20, 21, id), null);

const regionCopy = duplicateRegionPiece(clip, 12.5, 14, id);
assert.equal(regionCopy.start, 18);
assert.equal(regionCopy.offset, 4.5);
assert.equal(regionCopy.duration, 1.5);
assert.equal(duplicateRegionPiece(clip, 20, 21, id), null);

console.log('timeline ops ok');
