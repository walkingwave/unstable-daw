# SA3 Studio Agent Editing Roadmap

## Goal

Evolve Studio from a chat-driven track generator into an editable music session
where the agent can generate, revise, extend, and version audio using Stable
Audio 3 while preserving the session's musical grid.

The first implementation should remain conservative: DeepSeek plans actions,
the backend validates and executes them, and session metadata is the durable
source of truth. DeepSeek should not directly call Stable Audio 3 or act as the
memory store.

## Current State

- Studio chat calls `/api/interpret`.
- DeepSeek, when configured, returns a track-generation plan.
- The frontend loops over `plan.tracks` and calls `/api/generate`.
- `/api/generate` creates a deterministic MIDI guide, renders guide audio,
  calls SA3 through the selected backend, aligns the result, and writes a stem.
- Session metadata stores analysis, arrangement, and generated stems, but not
  editable clip/version history.

This supports prompts like "add drums and bass in bossa nova." It does not yet
support prompts like "replace bars 5-8 of the bass," "extend this by 8 bars,"
or "make the selected clip darker."

## Implementation Phases

### 0. Verify Prerequisites Before More Agent Work

Do this before implementing the larger editing layer.

1. Merge or rebase the DeepSeek branch onto the latest `main`.
2. Preserve the DeepSeek config removed by newer `main` changes:
   - `.env.example` should include `DEEPSEEK_API_KEY`,
     `BTG_AGENT_PROVIDER`, and `BTG_AGENT_MODEL`.
   - `backend/config.py` should load `.env` and expose the DeepSeek settings.
3. Verify DeepSeek is actually being used:
   - Set `DEEPSEEK_API_KEY` in local `.env`.
   - Start the backend.
   - Call `/api/interpret`.
   - Confirm the response has `"interpreter": "deepseek"`, not `"rules"`.
4. Verify local SA3 on the target machine:
   - On Apple Silicon, use the MLX runtime.
   - On Windows/Linux, latest `main` adds a PyTorch runtime through
     `uv sync --extra local`.
   - Confirm the backend selector reports `local` as available.
   - Generate one short stem with `--backend local`.

Do not start the edit/extend implementation until DeepSeek and at least one real
SA3 backend are confirmed.

## Main Change From Latest `main`

Latest `main` adds a broader local backend:

- `local` is no longer Apple-Silicon-only in the code on `main`.
- It now chooses between:
  - MLX runtime for Apple Silicon.
  - PyTorch `stable_audio_3` runtime for Windows, Linux, and non-MLX machines.
- Windows setup is documented through `scripts/setup.ps1`.
- `BTG_TORCH_DIT` controls the PyTorch model, defaulting to `small-music`.

For our branch, this means the DeepSeek work needs to be reconciled with
`main` before more backend work. The local SA3 path should remain one `local`
backend in the UI, but its implementation should include both MLX and PyTorch.

## 1. Session State And Metadata

Current session metadata is stem-oriented. We need project-oriented state.

Add durable records for:

- Tracks.
- Clips.
- Track versions.
- Edit operations.
- Agent actions.
- Chat messages.
- A compact session summary for agent context.

Proposed shape:

```json
{
  "id": "session_id",
  "analysis": {},
  "arrangement": {},
  "tracks": {
    "track_id": {
      "id": "track_id",
      "name": "Bass",
      "part": "bass",
      "current_version": "version_id",
      "versions": [],
      "clips": []
    }
  },
  "operations": [],
  "chat": [],
  "agent_summary": ""
}
```

Backend changes:

- Add dataclasses/Pydantic models in `backend/models.py`.
- Add methods in `backend/session.py`:
  - `save_track`
  - `add_track_version`
  - `record_operation`
  - `save_chat_message`
  - `agent_context`
  - `set_current_version`

Rule: generated or edited audio should create a new version, not overwrite the
previous version.

## 2. Audio Editing Utilities

Create `backend/audio_ops.py` for deterministic audio operations:

- Convert bars/beats to seconds.
- Cut audio regions.
- Replace a region with generated audio.
- Append extensions.
- Pad/trim to bar-aligned lengths.
- Crossfade splice boundaries.
- Normalize or level-match outputs.

These operations should be unit-testable without SA3.

## 3. Pipeline Operations

Extend `backend/pipeline.py` beyond full-track generation.

Add operations:

- `edit_region`
  - Input: track/version, start bar, end bar, prompt, strength/noise.
  - Uses the selected region as init audio.
  - Generates replacement audio.
  - Aligns and splices it into a new version.

- `extend_track`
  - Input: track/version, number of bars, prompt.
  - Uses the last bars as reference.
  - Generates a continuation.
  - Aligns and appends it as a new version.

- `remix_track`
  - Input: whole track/version and prompt.
  - Runs audio-to-audio over the whole clip.
  - Saves a new version.

- `generate_section`
  - Input: part, start bar, bars, prompt.
  - Generates a new section against the session grid.
  - Inserts it into a track or creates a new one.

Every operation should record provenance:

- source version
- prompt
- backend
- seed
- noise/strength
- region
- output path
- created timestamp

## 4. SA3 Backend Capability Layer

Current backend abstraction is:

```python
generate(prompt, init_audio, noise, duration, seed)
```

Add intent-level methods or a capability wrapper:

- `text_to_audio`
- `audio_to_audio`
- `edit_audio_region`
- `extend_audio`

The first version can still route most actions through audio-to-audio. The
important change is that the rest of the app talks in Studio operations, not raw
SA3 arguments.

Capability reporting should include:

- backend id
- runtime name
- text-to-audio support
- audio-to-audio support
- native extend support, if available
- max duration, if known

If the local runtime does not expose native extend, implement extension through
our own orchestration: condition on the last bars, generate a continuation,
align it, and append it.

## 5. API Layer

Keep existing endpoints for manual actions, but add an agent execution path.

Recommended additions:

- `POST /api/agent`
  - Input: session id, user message, selected track/clip/region, backend.
  - Backend loads canonical session state.
  - Backend builds agent context.
  - DeepSeek returns structured actions.
  - Backend validates and executes actions.
  - Backend records chat/actions/operations.
  - Response returns updated session state and new audio URLs.

Lower-level endpoints for UI controls:

- `POST /api/session/{id}/tracks/{track_id}/edit-region`
- `POST /api/session/{id}/tracks/{track_id}/extend`
- `POST /api/session/{id}/tracks/{track_id}/remix`
- `POST /api/session/{id}/undo`
- `POST /api/session/{id}/redo`

The agent endpoint should call the same lower-level services as the manual UI
controls so behavior stays consistent.

## 6. DeepSeek Action Planner

Change `backend/interpret.py` from `Plan.tracks` to an action schema.

Example output:

```json
{
  "actions": [
    {
      "type": "edit_region",
      "track_id": "bass",
      "start_bar": 9,
      "end_bar": 12,
      "prompt": "make the bass more distorted",
      "strength": 0.7
    }
  ],
  "notes": ""
}
```

Supported first-pass actions:

- `generate_track`
- `edit_region`
- `extend_track`
- `remix_track`
- `generate_from_reference`
- `change_arrangement`

Prompt requirements:

- Include the available action schema.
- Include current session analysis: BPM, key, mode, bars, chords.
- Include tracks, clips, versions, and selected region.
- Include recent operations and a compact session summary.
- Tell DeepSeek to preserve tempo, key, and length unless explicitly changed.
- Tell DeepSeek to create versions and never overwrite source audio.
- Tell DeepSeek it cannot call SA3 directly.

Validation requirements:

- Reject unknown action types.
- Reject missing tracks or out-of-range regions.
- Clamp strength/noise.
- Require confirmation later for destructive project-wide changes.

## 7. Frontend Studio

Current Studio flow:

```text
runRequest -> /api/interpret -> for each track -> /api/generate
```

New flow:

```text
runRequest -> /api/agent -> apply returned session/timeline updates
```

Frontend should send:

- `session_id`
- user message
- selected track id
- selected clip id
- selected region
- selected backend

Frontend should render:

- generated actions
- new versions
- current version per track
- edit status
- undo/redo state

The frontend should stop executing individual planned tracks itself once the
agent endpoint exists. The backend should execute the plan so validation,
session updates, and provenance are centralized.

## 8. Tests

Add tests that do not require DeepSeek or SA3:

- Session migration from old `stems` metadata to new `tracks`.
- `edit_region` creates a new version.
- `extend_track` appends a bar-aligned result.
- Invalid agent actions are rejected.
- Agent context includes selected region and recent operations.
- DeepSeek fallback still produces a valid plan when no key is present.

Add integration checks with `mock`:

- `/api/agent` can generate a track.
- `/api/agent` can edit a selected region.
- `/api/agent` can extend a track.

Add manual real-model checks:

- DeepSeek response reports `interpreter: deepseek`.
- Local SA3 reports available.
- One generated stem succeeds with `--backend local`.
- One audio-to-audio reference generation succeeds with `--backend local`.

## Open Questions

- Does the local MLX runtime expose native extend, or do we approximate it?
- Does the PyTorch `stable_audio_3` package expose the same parameters as MLX?
- Should edits be clip-level or track-version-level in the first UI?
- How much chat history should be kept in DeepSeek context before summarizing?
- Do we need user confirmation before project-wide changes like changing BPM or
  key after stems already exist?

## Recommended Next Step

Before starting this roadmap, rebase `deepseek-agent-integration` onto latest
`main`, preserve DeepSeek configuration, and test:

```bash
uv run python -c "from backend import interpret; print(interpret.interpreter_name())"
uv run btg --input samples/fixtures/amin_100.wav --part bass --backend local
```

The first command should print `deepseek` when `.env` has `DEEPSEEK_API_KEY`.
The second command should produce a real local SA3 stem on the target machine.
