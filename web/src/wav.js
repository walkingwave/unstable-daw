// Convert any browser-decodable audio blob (webm/opus from MediaRecorder,
// mp3, m4a, wav) into a 16-bit PCM WAV. The backend decodes with libsndfile,
// which has no webm/opus support and there is no ffmpeg on the host — doing
// the decode here with the Web Audio API sidesteps both.

export async function blobToWav(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  return encodeWav(decoded);
}

// Encode a decoded AudioBuffer (or a region of one) to a WAV Blob, for
// per-clip download straight from what is loaded in the timeline.
export function audioBufferToWav(buffer, offsetSec = 0, durationSec = null) {
  if (offsetSec === 0 && durationSec == null) return encodeWav(buffer);
  const sr = buffer.sampleRate;
  const startFrame = Math.max(0, Math.min(buffer.length, Math.floor((offsetSec || 0) * sr)));
  const requestedFrames = durationSec == null
    ? buffer.length - startFrame
    : Math.floor(Math.max(0, durationSec || 0) * sr);
  const frames = Math.max(0, Math.min(requestedFrames, buffer.length - startFrame));
  if (frames <= 0) throw new Error('Selected audio region is empty');
  const region = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: frames,
    sampleRate: sr,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    region.copyToChannel(buffer.getChannelData(c).subarray(startFrame, startFrame + frames), c);
  }
  return encodeWav(region);
}

function encodeWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;

  const out = new DataView(new ArrayBuffer(44 + dataSize));
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) out.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  out.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  out.setUint32(16, 16, true); // PCM chunk size
  out.setUint16(20, 1, true); // format = PCM
  out.setUint16(22, numChannels, true);
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * blockAlign, true);
  out.setUint16(32, blockAlign, true);
  out.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, 'data');
  out.setUint32(40, dataSize, true);

  // Interleave channels, clamp, convert float [-1,1] to signed 16-bit.
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      out.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([out.buffer], { type: 'audio/wav' });
}
