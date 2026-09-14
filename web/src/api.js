// Thin wrapper over the backend's /api routes. Mirrors the contract in
// PLAN.md. Every call throws Error("<status>: <detail>") on failure so the
// UI can surface it in a toast.

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, options);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status}: ${detail}`);
  }
  return response.json();
}

const postJSON = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const listBackends = () => api('/backends');
export const listSessions = () => api('/sessions');
export const getSession = (sessionId) => api(`/session/${sessionId}`);
export const deleteSession = (sessionId) => api(`/session/${sessionId}`, { method: 'DELETE' });

export async function analyze(blob, filename) {
  const form = new FormData();
  form.append('file', blob, filename);
  return api('/analyze', { method: 'POST', body: form });
}


// Rename a session server-side, so the Projects list agrees with the header.
export const renameSession = (sessionId, name) =>
  api(`/session/${sessionId}/name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
export const updateAnalysis = (sessionId, edit) =>
  api(`/session/${sessionId}/analysis`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(edit),
  });

export const generate = (body) => postJSON('/generate', body);
export const generateFromHum = (body) => postJSON('/generate-from-hum', body); // legacy
export const transformHum = (body) => postJSON('/transform-hum', body);

// Start a session with no source audio, for composing from nothing.
export const createBlankSession = (body) => postJSON('/session/blank', body);

// Played notes + a prompt -> a real instrument. The notes become the guide
// track, so the performance survives and only the timbre is generated.
export const generateFromMidi = (body) => postJSON('/generate-from-midi', body);

// One-shot samples for an instrument. Cached server-side by prompt, so
// loading the same instrument again costs nothing.
export const instrumentSamples = (body) => postJSON('/instrument/samples', body);

export const interpret = (text, sessionId, mode) =>
  postJSON('/interpret', { text, session_id: sessionId ?? null, mode: mode ?? null });

// Studio chat -> explicit timeline/backend actions. The server uses DeepSeek
// when configured and falls back to deterministic parsing.
export const planAgentActions = ({ message, sessionId, studioContext }) =>
  postJSON('/agent/plan', {
    message,
    session_id: sessionId ?? null,
    studio_context: studioContext ?? {},
  });

// Describe a part in words, get back NOTES rather than audio. The phrase
// lands on a MIDI track, so it stays editable in the piano roll.
export const composeMidi = (body) => postJSON('/compose-midi', body);

// Master-first: generate the whole band as one record, get it back split
// into stems. Used for multi-track plans so the parts are one performance.
export const generateSong = (body) => postJSON('/generate-song', body);

// What the long-running song pipeline is doing right now, for the status bar.
export const sessionProgress = (sessionId) => api(`/session/${sessionId}/progress`);

export const getTimeline = (sessionId) => api(`/session/${sessionId}/timeline`);

export const saveTimeline = (sessionId, timeline) =>
  api(`/session/${sessionId}/timeline`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(timeline),
  });

export const listOperations = (sessionId, limit = 100) =>
  api(`/session/${sessionId}/operations?limit=${limit}`);

export const recordOperation = (sessionId, operation) =>
  postJSON(`/session/${sessionId}/operations`, operation);

export async function uploadSessionAudio(sessionId, blob, name = 'clip') {
  const form = new FormData();
  form.append('name', name);
  form.append('audio', blob, `${name}.wav`);
  return api(`/session/${sessionId}/uploads/audio`, { method: 'POST', body: form });
}

// Generate a clip guided by audio the user picked, rather than by a guide
// track synthesized from the chord grid. `referenceWav` is a Blob.
export async function generateFromReference({
  sessionId,
  referenceWav,
  prompt,
  noise,
  backend,
  seed,
  name,
}) {
  const form = new FormData();
  form.append('session_id', sessionId);
  form.append('prompt', prompt ?? '');
  if (noise != null) form.append('noise', String(noise));
  if (backend) form.append('backend', backend);
  if (seed != null) form.append('seed', String(seed));
  form.append('name', name || 'clip');
  form.append('audio', referenceWav, 'reference.wav');
  return api('/generate-from-reference', { method: 'POST', body: form });
}

export const vocalUrl = (sessionId) => `/api/session/${sessionId}/vocal.wav`;
export const stemUrl = (sessionId, part) =>
  `/api/session/${sessionId}/audio/stems/${part}.wav`;
export const exportUrl = (sessionId) => `/api/session/${sessionId}/export`;
