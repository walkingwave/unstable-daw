"""HTTP API and static file server.

    uv run uvicorn backend.api:app --reload

Then open http://127.0.0.1:8000

Routes are thin: they validate input, call into `pipeline`, and serialize
the result. Musical logic belongs in the pipeline modules, not here.
"""

from __future__ import annotations

import io
import logging
import threading
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
import soundfile as sf
import pretty_midi

from . import agent, compose, config, hum_transform, instruments, interpret, pipeline, sa3_backend
from .analysis import rebuild_bar_grid
from .models import PARTS
from .session import Session

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

config.ensure_dirs()
app = FastAPI(title="Backing Track Generator")

_active_sessions: set[str] = set()
_deleting_sessions: set[str] = set()
_active_sessions_lock = threading.Lock()


@contextmanager
def _generation_for(session_id: str):
    with _active_sessions_lock:
        if session_id in _active_sessions or session_id in _deleting_sessions:
            raise HTTPException(409, "generation is already active or the session is closing")
        _active_sessions.add(session_id)
    try:
        yield
    finally:
        with _active_sessions_lock:
            _active_sessions.discard(session_id)


# --- request bodies -----------------------------------------------------


class GenerateRequest(BaseModel):
    session_id: str
    part: str
    style: str | None = None  # None -> inherit the session's arrangement
    noise: float | None = None  # None -> per-part default
    backend: str | None = None
    seed: int | None = None
    bars: int | None = None  # target length in bars; None -> input vocal length
    start_bar: int = 0  # chord-grid offset, for section regeneration
    name: str | None = None  # track name; several tracks may share a part
    instrument: str = ""  # replaces the part's default instrument description
    # Shared recording character for the whole arrangement. None inherits
    # whatever the session already agreed on.
    production: str | None = None
    # Position among the same-role tracks in this request, so the backend can
    # have leads trade phrases instead of all soloing at once.
    voice_index: int = 0
    voice_count: int = 1
    # Whether the stems already on the timeline are mixed under this one as
    # context. None lets the backend decide from the request text.
    ensemble: bool | None = None



class HumGenerateRequest(BaseModel):
    session_id: str
    target: str | None = None  # melody | bass; inferred from prompt when omitted
    prompt: str = ""
    noise: float | None = None
    backend: str | None = None
    seed: int | None = None
    name: str | None = None
    faithful: bool = True
    snap_to_key: bool = False
    quantize: bool = False
    quantize_division: int = 8
    render_audio: bool = True


class TransformHumRequest(BaseModel):
    """Deterministic hum-to-MIDI request; deliberately has no SA3 fields."""

    model_config = ConfigDict(extra="forbid")

    session_id: str
    target: str  # melody | bass
    name: str | None = None
    faithful: bool = True
    snap_to_key: bool = False
    quantize: bool = False
    quantize_division: int = Field(default=8, ge=1, le=32)


class AnalysisEdit(BaseModel):
    """User corrections to the detected structure. Every field optional.

    Detection is good but not perfect, and a wrong key or tempo poisons
    every stem generated afterwards. Correcting it has to be one edit, not
    a re-record.
    """

    bpm: float | None = None
    key: str | None = None
    mode: str | None = None
    chords: list[str] | None = None  # one per bar, in order


# --- routes -------------------------------------------------------------


@app.get("/api/backends")
def list_backends() -> list[dict]:
    """Which backends exist and which can run right now.

    The UI uses `available` to disable options rather than letting the
    user pick something that will fail.
    """
    return sa3_backend.describe()


@app.post("/api/analyze")
async def analyze(file: UploadFile) -> dict:
    """Upload a vocal, get back a session id and the detected structure."""
    upload_path = config.SESSIONS_DIR / f"upload-{file.filename}"
    upload_path.write_bytes(await file.read())

    try:
        session, analysis = pipeline.analyze_vocal(upload_path)
        session.set_display_name(Path(file.filename or "Recording").stem)
    finally:
        upload_path.unlink(missing_ok=True)

    return {
        "session_id": session.id,
        "analysis": analysis.to_dict(),
        "pitch_tracking": session.to_dict().get("pitch_tracking", {}),
    }


@app.post("/api/transform-hum")
def transform_hum(request: TransformHumRequest) -> dict:
    """Turn a saved hum into editable MIDI without invoking any audio backend."""
    if request.target not in ("melody", "bass"):
        raise HTTPException(400, "target must be 'melody' or 'bass'")
    session = _load(request.session_id)
    name = pipeline.track_name(session, request.target, request.name)
    options = hum_transform.TransformOptions(
        faithful=request.faithful, snap_to_key=request.snap_to_key,
        quantize=request.quantize, quantize_division=request.quantize_division,
    )
    try:
        with _generation_for(session.id):
            result = pipeline.transform_hum_to_midi(session, request.target, name, options)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return {
        "session_id": session.id, **result,
        "midi_url": f"/api/session/{session.id}/midi/{result['name']}.mid",
        "pitch_tracking": session.to_dict().get("pitch_tracking", {}).get("tracker_id", "unknown"),
    }


@app.post("/api/generate-from-hum")
def generate_from_hum(request: HumGenerateRequest) -> dict:
    """Deprecated compatibility route; hum transformation is now MIDI-only."""
    target = request.target or interpret.hum_target(request.prompt)
    return {
        **transform_hum(TransformHumRequest(
            session_id=request.session_id, target=target, name=request.name,
            faithful=request.faithful, snap_to_key=request.snap_to_key,
            quantize=request.quantize, quantize_division=request.quantize_division,
        )),
        "deprecated": "use /api/transform-hum; no Stable Audio render was requested",
    }



class RenameRequest(BaseModel):
    name: str


@app.patch("/api/session/{session_id}/name")
def rename_session(session_id: str, request: RenameRequest) -> dict:
    """Rename a session so the picker shows what the header shows.

    Without this the rename lived only in the browser: the header said one
    name and the Projects list said another, because the list is built from
    the server's display_name.
    """
    session = _load(session_id)
    name = request.name.strip()[:80]
    if name:
        session.set_display_name(name)
    return {"display_name": name}

@app.patch("/api/session/{session_id}/analysis")
def update_analysis(session_id: str, edit: AnalysisEdit) -> dict:
    """Apply user corrections to the detected structure.

    Later generations use the corrected values. Changing the tempo
    rebuilds the bar grid, since bar boundaries are derived from it.
    """
    session = _load(session_id)
    analysis = session.analysis

    if edit.key is not None:
        analysis.key = edit.key
    if edit.mode is not None:
        if edit.mode not in ("major", "minor"):
            raise HTTPException(400, "mode must be 'major' or 'minor'")
        analysis.mode = edit.mode

    if edit.bpm is not None:
        if not 20 <= edit.bpm <= 300:
            raise HTTPException(400, "bpm must be between 20 and 300")
        analysis.bpm = edit.bpm
        rebuild_bar_grid(analysis)

    if edit.chords is not None:
        if len(edit.chords) != len(analysis.bars):
            raise HTTPException(
                400, f"expected {len(analysis.bars)} chords, got {len(edit.chords)}"
            )
        for bar, chord in zip(analysis.bars, edit.chords):
            bar.chord = chord

    session.save_analysis(analysis)
    return analysis.to_dict()


@app.post("/api/generate")
def generate(request: GenerateRequest) -> dict:
    """Generate one backing stem.

    `backend_used` in the response may differ from what was requested, if
    the chosen backend failed and the pipeline fell back.
    """
    if request.part not in PARTS:
        raise HTTPException(400, f"unknown part: {request.part}")

    session = _load(request.session_id)
    try:
        with _generation_for(session.id):
            result = pipeline.generate_stem(
                session,
                part=request.part,
                style=request.style,
                noise=request.noise,
                backend=request.backend,
                seed=request.seed,
                bars=request.bars,
                start_bar=request.start_bar,
                name=pipeline.track_name(session, request.part, request.name),
                instrument=request.instrument,
                production=request.production,
                voice_index=request.voice_index,
                voice_count=request.voice_count,
                ensemble=request.ensemble,
            )
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error

    return {
        **result.to_dict(),
        # Files are keyed by track name, not part, so two pitched tracks do
        # not overwrite each other. The seed query busts the browser cache
        # so a regenerate fetches fresh audio.
        "audio_url": f"/api/session/{session.id}/audio/stems/{result.name}.wav?v={result.seed}",
    }



class SongTrack(BaseModel):
    part: str
    name: str | None = None
    instrument: str = ""
    voice_index: int = 0
    voice_count: int = 1


class SongRequest(BaseModel):
    session_id: str
    tracks: list[SongTrack]
    style: str | None = None
    production: str | None = None
    backend: str | None = None
    seed: int | None = None
    bars: int | None = None
    # The user's request verbatim, so the master is generated from their
    # words rather than only the agent's paraphrase of them.
    description: str | None = None



@app.get("/api/session/{session_id}/progress")
def session_progress(session_id: str) -> dict:
    """What a long-running generate-song is doing right now.

    The song pipeline (master take, separation, per-stem work) runs minutes
    on CPU inside one POST; the UI polls this so the wait reads as progress
    rather than a hang. Empty string means nothing is running.
    """
    return {"status": pipeline.PROGRESS.get(session_id, "")}

@app.post("/api/generate-song")
def generate_song(request: SongRequest) -> dict:
    """Generate a whole arrangement master-first and return it as stems.

    One model call renders the full band, then each stem is carved out of
    that master — so the stems are one performance split apart, not separate
    takes stacked. This is the endpoint the prompt bar uses for multi-track
    plans; single tracks still go through /api/generate.
    """
    for track in request.tracks:
        if track.part not in PARTS:
            raise HTTPException(400, f"unknown part: {track.part}")
    if not request.tracks:
        raise HTTPException(400, "no tracks requested")

    session = _load(request.session_id)
    try:
        with _generation_for(session.id):
            results = pipeline.generate_song(
                session,
                tracks=[t.model_dump() for t in request.tracks],
                style=request.style,
                production=request.production,
                backend=request.backend,
                seed=request.seed,
                bars=request.bars,
                description=request.description,
            )
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error

    return {
        "stems": [
            {
                **result.to_dict(),
                "audio_url": f"/api/session/{session.id}/audio/stems/{result.name}.wav?v={result.seed}",
            }
            for result in results
        ]
    }

class InterpretRequest(BaseModel):
    text: str
    session_id: str | None = None
    # What the user picked in the UI: "stems" (a track per instrument),
    # "single" (the whole band in one track), or "midi" (editable notes).
    # Explicit because phrasing does not settle it — "a drum backing track"
    # is one stem to a musician and a whole arrangement to a model reading
    # the word "track".
    mode: str | None = None


@app.post("/api/interpret")
def interpret_request(request: InterpretRequest) -> dict:
    """Turn a plain-English request into a generation plan.

    When a session is given, its style, tempo, key and existing parts are
    passed as context so a follow-up ("add a piano") extends the current
    arrangement instead of starting a conflicting one.

    Uses DeepSeek when credentials are available and falls back to keyword
    matching otherwise, so this endpoint always returns a usable plan
    rather than failing when offline.
    """
    context = None
    if request.session_id:
        try:
            session = Session.load(request.session_id)
            analysis = session.analysis
            arrangement = session.arrangement
            context = interpret.Context(
                style=arrangement.style,
                bars=arrangement.bars,
                bpm=analysis.bpm,
                key=analysis.key,
                mode=analysis.mode,
                existing_parts=list(session.to_dict().get("stems", {})),
            )
        except (FileNotFoundError, ValueError):
            context = None  # unanalyzed or missing session - no context to add

    plan, source = interpret.interpret_with_source(request.text, context, request.mode)
    return {**plan.model_dump(), "interpreter": source}


class AgentPlanRequest(BaseModel):
    message: str
    session_id: str | None = None
    studio_context: dict = {}


@app.post("/api/agent/plan")
def agent_plan(request: AgentPlanRequest) -> dict:
    """Turn a Studio chat message into executable UI/backend actions."""
    raw = request.studio_context or {}
    context = agent.AgentRequestContext(
        original_request=request.message,
        session_id=request.session_id,
        bpm=raw.get("bpm"),
        key=raw.get("key"),
        mode=raw.get("mode"),
        backend=raw.get("backend"),
        seconds_per_bar=raw.get("seconds_per_bar"),
        playhead=raw.get("playhead"),
        duration=raw.get("duration"),
        selected_track_id=raw.get("selected_track_id"),
        selected_clip_id=raw.get("selected_clip_id"),
        selected_region=raw.get("selected_region"),
        tracks=raw.get("tracks") or [],
        recent_actions=raw.get("recent_actions") or [],
    )
    plan, source = agent.plan_actions(request.message, context)
    return {**plan.model_dump(), "interpreter": source}


class ComposeMidiRequest(BaseModel):
    text: str
    session_id: str | None = None
    # The client may already know the length it wants (a clip being replaced,
    # or the arrangement's bar count); otherwise the composer picks.
    bars: int | None = None
    bpm: float | None = None
    key: str | None = None
    mode: str | None = None
    style: str | None = None


@app.post("/api/compose-midi")
def compose_midi(request: ComposeMidiRequest) -> dict:
    """Write a MIDI phrase from a description.

    Returns notes in beats, not audio: the client puts them on a MIDI track
    and plays them through the sampler, so the result stays editable in the
    piano roll instead of being baked into a wav.

    Session settings seed the context, and anything passed explicitly on the
    request wins over them — the Studio's tempo box is more current than the
    tempo detected from the original vocal.
    """
    context = compose.Context(
        bpm=request.bpm,
        key=request.key,
        mode=request.mode,
        bars=request.bars,
        style=request.style or "",
    )
    if request.session_id:
        try:
            session = Session.load(request.session_id)
            analysis = session.analysis
            arrangement = session.arrangement
            context = compose.Context(
                bpm=request.bpm or analysis.bpm,
                key=request.key or analysis.key,
                mode=request.mode or analysis.mode,
                bars=request.bars or arrangement.bars,
                style=request.style or arrangement.style or "",
            )
        except (FileNotFoundError, ValueError):
            pass  # unanalyzed or missing session - the request's own values stand

    phrase, source = compose.compose(request.text, context)
    if not phrase.notes:
        raise HTTPException(422, "the composer returned no notes - try describing the part differently")
    return {**phrase.model_dump(), "composer": source}


class SamplesRequest(BaseModel):
    prompt: str
    takes: int | None = None
    backend: str | None = None
    seed: int | None = None
    force: bool = False


@app.post("/api/instrument/samples")
def instrument_samples(request: SamplesRequest) -> dict:
    """Generate one sustained one-shot per pitch for an instrument.

    The browser then plays MIDI through these, so the notes are exactly
    what was played and editing needs no further generation. Results are
    cached by prompt, so loading the same instrument again is free.
    """
    if not request.prompt.strip():
        raise HTTPException(400, "an instrument needs a description")

    try:
        made = instruments.generate_samples(
            request.prompt,
            takes=max(1, min(6, request.takes or instruments.DEFAULT_TAKES)),
            backend=request.backend,
            seed=request.seed,
            force=request.force,
        )
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error

    ident = instruments.instrument_id(request.prompt)
    return {
        "instrument_id": ident,
        # Takes are not asked to hit a pitch; each one lands where it
        # lands and reports it, and the sampler transposes from there.
        "samples": [
            {
                "actual_pitch": s["actual_pitch"],
                "url": f"/api/instrument/{ident}/{s['index']}.wav",
            }
            for s in made
        ],
    }


@app.get("/api/instrument/{ident}/{index}.wav")
def instrument_sample(ident: str, index: int) -> FileResponse:
    # Ids are hex digests (instruments.instrument_id). Anything else, "..",
    # say, would walk out of the instrument cache.
    if len(ident) != 16 or any(c not in "0123456789abcdef" for c in ident) or index < 0:
        raise HTTPException(404, "sample not found")
    path = config.CACHE_DIR / "instruments" / ident / f"{index}.wav"
    if not path.is_file():
        raise HTTPException(404, "sample not found")
    return FileResponse(path, media_type="audio/wav")


class MidiNote(BaseModel):
    pitch: int
    start: float  # beats from the clip's start
    length: float = 1.0  # beats
    velocity: int = 90


class MidiRequest(BaseModel):
    session_id: str | None = None
    notes: list[MidiNote]
    prompt: str = ""
    noise: float | None = None
    backend: str | None = None
    seed: int | None = None
    name: str = "instrument"
    bars: int | None = None
    # Only used when no session exists yet, so the instrument view works
    # before anything else has been recorded or generated.
    bpm: float = 100.0
    key: str = "A"
    mode: str = "minor"


@app.post("/api/generate-from-midi")
def generate_from_midi(request: MidiRequest) -> dict:
    """Turn played notes into a real instrument.

    The notes become the guide track, so the performance is preserved
    exactly while Stable Audio 3 supplies the sound described by `prompt`.
    """
    if not request.notes:
        raise HTTPException(400, "no notes to generate from")

    if request.session_id:
        session = _load(request.session_id)
    else:
        session, _ = pipeline.create_blank_session(
            bpm=request.bpm, key=request.key, mode=request.mode, bars=request.bars or 8
        )

    try:
        with _generation_for(session.id):
            result = pipeline.generate_from_notes(
                session,
                notes=[n.model_dump() for n in request.notes],
                prompt=request.prompt,
                noise=request.noise,
                backend=request.backend,
                seed=request.seed,
                name=pipeline.track_name(session, "free", request.name),
                bars=request.bars,
            )
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error

    return {
        **result.to_dict(),
        "session_id": session.id,
        "audio_url": f"/api/session/{session.id}/audio/stems/{result.name}.wav?v={result.seed}",
    }


@app.get("/api/session/{session_id}/arrangement")
def get_arrangement(session_id: str) -> dict:
    """The style and length every part in this session shares."""
    return _load(session_id).arrangement.to_dict()


class BlankSessionRequest(BaseModel):
    bpm: float = 100.0
    key: str = "A"
    mode: str = "minor"
    bars: int = 8


@app.post("/api/session/blank")
def create_blank_session(request: BlankSessionRequest) -> dict:
    """Start a session with no vocal, for composing from nothing.

    Everything downstream keys off an Analysis, so writing to a project
    without a recording just means supplying tempo, key and a starting
    chord grid instead of inferring them.
    """
    if not 20 <= request.bpm <= 300:
        raise HTTPException(400, "bpm must be between 20 and 300")
    if request.mode not in ("major", "minor"):
        raise HTTPException(400, "mode must be 'major' or 'minor'")
    if not 1 <= request.bars <= 128:
        raise HTTPException(400, "bars must be between 1 and 128")

    session, analysis = pipeline.create_blank_session(
        bpm=request.bpm, key=request.key, mode=request.mode, bars=request.bars
    )
    return {"session_id": session.id, "analysis": analysis.to_dict()}


class TimelineRequest(BaseModel):
    version: int = 1
    bpm: float | None = None
    key: str | None = None
    mode: str | None = None
    tracks: list[dict] = []


@app.get("/api/session/{session_id}/timeline")
def get_timeline(session_id: str) -> dict:
    """Current editable Studio timeline for this session."""
    return _load(session_id).timeline or {"version": 1, "tracks": []}


@app.put("/api/session/{session_id}/timeline")
def save_timeline(session_id: str, request: TimelineRequest) -> dict:
    """Persist the browser Studio timeline as serializable metadata."""
    timeline = request.model_dump()
    return _load(session_id).save_timeline(timeline)


class OperationRequest(BaseModel):
    source: str = "manual"
    type: str
    message: str = ""
    actions: list[dict] = []
    result: dict = {}


@app.get("/api/session/{session_id}/operations")
def get_operations(session_id: str, limit: int = 100) -> list[dict]:
    return _load(session_id).operations(limit=max(1, min(200, limit)))


@app.post("/api/session/{session_id}/operations")
def record_operation(session_id: str, request: OperationRequest) -> dict:
    return _load(session_id).record_operation(request.model_dump())


@app.post("/api/session/{session_id}/uploads/audio")
async def upload_audio(session_id: str, audio: UploadFile = File(...), name: str = Form("clip")) -> dict:
    """Persist imported/recorded browser audio so timeline restore can fetch it."""
    session = _load(session_id)
    filename = f"{_safe_name(Path(name or audio.filename or 'clip').stem)}-{uuid.uuid4().hex[:8]}.wav"

    source, sr = sf.read(io.BytesIO(await audio.read()), dtype="float32")
    if source.ndim > 1:
        source = source.mean(axis=1)
    if sr != config.SAMPLE_RATE:
        import librosa

        source = librosa.resample(source, orig_sr=sr, target_sr=config.SAMPLE_RATE)

    path = session.upload_path(filename)
    session.write_audio(path, source)
    return {
        "audio_url": f"/api/session/{session.id}/audio/uploads/{filename}",
        "duration": len(source) / config.SAMPLE_RATE,
    }


@app.post("/api/generate-from-reference")
async def generate_from_reference(
    session_id: str = Form(...),
    prompt: str = Form(""),
    noise: float = Form(config.DEFAULT_NOISE),
    backend: str | None = Form(None),
    seed: int | None = Form(None),
    name: str = Form("clip"),
    audio: UploadFile = File(...),
) -> dict:
    """Generate a clip guided by audio the user supplies, not a synthesized guide.

    The studio posts the rendered audio of whichever track was chosen as the
    reference. Same audio-to-audio mechanism as a normal stem — the reference
    simply takes the place of the arranger's guide track.
    """
    session = _load(session_id)

    reference, sr = sf.read(io.BytesIO(await audio.read()), dtype="float32")
    if reference.ndim > 1:
        reference = reference.mean(axis=1)
    if sr != config.SAMPLE_RATE:
        import librosa

        reference = librosa.resample(reference, orig_sr=sr, target_sr=config.SAMPLE_RATE)

    try:
        with _generation_for(session.id):
            result = pipeline.generate_from_reference(
                session,
                reference=reference,
                prompt=prompt,
                noise=noise,
                backend=backend,
                seed=seed,
                name=_safe_name(name),
            )
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error

    return {
        **result.to_dict(),
        "audio_url": f"/api/session/{session.id}/audio/stems/{_safe_name(name)}.wav",
    }


def _hum_midi_notes(session: Session, name: str) -> list[dict]:
    midi = pretty_midi.PrettyMIDI(str(session.midi_path(name)))
    beat = session.analysis.seconds_per_beat
    return [
        {"pitch": note.pitch, "start": note.start / beat, "length": (note.end - note.start) / beat,
         "velocity": note.velocity}
        for instrument in midi.instruments for note in instrument.notes
    ]


def _safe_name(name: str) -> str:
    """Filesystem-safe stem name. These become paths, so no traversal."""
    cleaned = "".join(c for c in name if c.isalnum() or c in "-_") or "clip"
    return cleaned[:40]


@app.get("/api/sessions")
def list_sessions() -> list[dict]:
    """List bounded, safe summaries of persisted local sessions."""
    summaries = []
    for root in (config.SESSIONS_DIR.iterdir() if config.SESSIONS_DIR.exists() else ()):
        if not root.is_dir() or root.is_symlink():
            continue
        try:
            summaries.append(Session.load(root.name).summary())
        except (FileNotFoundError, ValueError, OSError):
            continue
    return sorted(summaries, key=lambda item: item["updated_at"] or "", reverse=True)[:100]


@app.get("/api/session/{session_id}")
def get_session(session_id: str) -> dict:
    return _load(session_id).to_dict()


@app.delete("/api/session/{session_id}")
def delete_session(session_id: str) -> dict:
    session = _load(session_id)
    with _active_sessions_lock:
        if session.id in _active_sessions or session.id in _deleting_sessions:
            raise HTTPException(409, "wait for generation to finish before deleting this session")
        _deleting_sessions.add(session.id)
    try:
        session.delete()
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    finally:
        with _active_sessions_lock:
            _deleting_sessions.discard(session.id)
    return {"deleted": session.id}


@app.get("/api/session/{session_id}/audio/{kind}/{filename}")
def get_audio(session_id: str, kind: str, filename: str) -> FileResponse:
    """Serve a wav from a session. `kind` is guides, stems, or uploads."""
    if kind not in ("guides", "stems", "uploads"):
        raise HTTPException(404, "not found")
    if Path(filename).name != filename or not filename.endswith(".wav"):
        raise HTTPException(404, "not found")

    session = _load(session_id)
    path = session.root / kind / filename
    if not path.is_file():
        raise HTTPException(404, "not found")

    return FileResponse(path, media_type="audio/wav")


@app.get("/api/session/{session_id}/midi/{filename}")
def get_midi(session_id: str, filename: str) -> FileResponse:
    if Path(filename).name != filename or not filename.endswith(".mid"):
        raise HTTPException(404, "not found")
    session = _load(session_id)
    path = session.root / "midi" / filename
    if not path.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="audio/midi")


@app.get("/api/session/{session_id}/vocal.wav")
def get_vocal(session_id: str) -> FileResponse:
    return FileResponse(_load(session_id).vocal_path, media_type="audio/wav")


@app.get("/api/session/{session_id}/export")
def export(session_id: str) -> StreamingResponse:
    """Zip of every stem, its MIDI, the vocal, and the provenance manifest.

    This is the deliverable a musician actually takes away: drop the WAVs
    on separate DAW tracks, or open the MIDI to re-voice the parts.
    """
    session = _load(session_id)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(session.vocal_path, "vocal.wav")
        archive.write(session.meta_path, "meta.json")
        for subdir in ("stems", "midi"):
            for path in sorted((session.root / subdir).glob("*")):
                archive.write(path, f"{subdir}/{path.name}")

    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="backing-{session_id}.zip"'},
    )


def _load(session_id: str) -> Session:
    try:
        return Session.load(session_id)
    except FileNotFoundError as error:
        raise HTTPException(404, str(error)) from error


# Mounted last, so it does not shadow the /api routes above.
app.mount("/", StaticFiles(directory=config.WEB_DIST_DIR, html=True), name="web")
