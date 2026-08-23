"""Plan Studio actions from a plain-English request.

DeepSeek does not execute anything. It returns a small list of typed actions
that the frontend can validate against its current timeline and execute using
the same functions as manual editing.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, field_validator

from . import config, interpret
from .models import PARTS

log = logging.getLogger(__name__)

ActionType = Literal[
    "generate_track",
    "fill_region",
    "compose_midi",
    "regen_clip",
    "regen_region",
    "sa3_edit_region",
    "split_clip",
    "move_clip",
    "duplicate_clip",
    "delete_clip",
    "delete_track",
    "extract_region",
    "crop_to_region",
    "extend_clip",
    "set_tempo_key",
    "ask_clarification",
]


class AgentAction(BaseModel):
    type: ActionType
    part: str | None = None
    name: str | None = None
    instrument: str = ""
    style: str = ""
    prompt: str = ""
    midi: bool = False
    track_id: str | None = None
    clip_id: str | None = None
    region: dict[str, float] | None = None
    target_start: float | None = None
    target_bar: float | None = None
    noise: float | None = None
    bars: int | None = None
    bpm: float | None = None
    key: str | None = None
    mode: str | None = None
    production: str = ""
    reason: str = ""

    @field_validator("instrument", "style", "prompt", "production", "reason", mode="before")
    @classmethod
    def _none_to_empty_string(cls, value: Any) -> str:
        return "" if value is None else value


class AgentPlan(BaseModel):
    actions: list[AgentAction] = Field(default_factory=list)
    notes: str = ""


class AgentRequestContext(BaseModel):
    original_request: str = ""
    session_id: str | None = None
    bpm: float | None = None
    key: str | None = None
    mode: str | None = None
    backend: str | None = None
    seconds_per_bar: float | None = None
    playhead: float | None = None
    duration: float | None = None
    selected_track_id: str | None = None
    selected_clip_id: str | None = None
    selected_region: dict[str, float] | None = None
    tracks: list[dict[str, Any]] = Field(default_factory=list)
    recent_actions: list[dict[str, Any]] = Field(default_factory=list)


def plan_actions(text: str, context: AgentRequestContext) -> tuple[AgentPlan, str]:
    """Return the best available Studio action plan and the planner source."""
    context.original_request = text
    try:
        return _plan_with_deepseek(text, context), "deepseek"
    except Exception as error:  # noqa: BLE001 - demo should degrade gracefully
        log.info("falling back to legacy generation plan: %s", error)
        return _fallback_plan(text, context), "rules"


def _plan_with_deepseek(text: str, context: AgentRequestContext) -> AgentPlan:
    if not interpret.deepseek_available():
        raise RuntimeError("DeepSeek is not configured")

    response = httpx.post(
        config.DEEPSEEK_API_URL,
        headers={
            "Authorization": f"Bearer {config.DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": config.BTG_AGENT_MODEL,
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "max_tokens": 1800,
            "messages": [
                {"role": "system", "content": _system_prompt()},
                {"role": "user", "content": _user_prompt(text, context)},
            ],
        },
        timeout=30.0,
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    if not content:
        raise RuntimeError("DeepSeek returned empty content")
    return _sanitize(AgentPlan.model_validate(json.loads(content)), context)


def _system_prompt() -> str:
    return f"""You are the connector for a browser music Studio.

Return ONLY valid JSON. You cannot call tools or Stable Audio 3 directly.
You choose actions; the app validates and executes them.

Available parts: {', '.join(PARTS)}.

Action types:
- generate_track: create a new audio track from the session's musical grid.
- fill_region: generate audio into an empty/silent gap on an existing track.
- compose_midi: create editable MIDI notes instead of audio.
- regen_clip: regenerate the selected clip from the deterministic guide.
- regen_region: regenerate the selected region from the deterministic guide.
- sa3_edit_region: send the selected audio region to Stable Audio 3 and replace it.
- split_clip: split the selected clip at the playhead/current time.
- move_clip: move a whole clip or selected region to another timeline position.
- duplicate_clip: duplicate the selected clip.
- delete_clip: delete a selected/specified clip, or delete only a region when
  a region is supplied.
- delete_track: delete an entire track and all clips on it.
- extract_region: cut the selected region into its own clip.
- crop_to_region: trim the selected clip down to only the selected region.
- extend_clip: generate a continuation and append it after the target clip.
- set_tempo_key: change BPM/key/mode.
- ask_clarification: ask for missing selection or ambiguous target.

Use generate_track only for adding new instruments, new layers, or a full
arrangement that should appear as a new track row.
Use fill_region when the user asks to fill a gap, silence, empty space, or
space between bars on an existing/selected/named track. This should create a
new clip on that same track, not a new track row.
Use sa3_edit_region when the user wants the selected audio to sound different:
"make this darker", "distort this section", "turn this into a synth", "add reverb here".
Use regen_region when they want a new take of the selected bars while preserving
the part's role and arrangement.
Use extend_clip when the user says a part cuts off, needs to continue, should
extend, should have an outro, or should keep going after the current ending.
Use delete_track when the user asks to remove, delete, or get rid of a track
or instrument lane. Use delete_clip with a region when they ask to delete
specific bars/seconds/sections of a clip. Use delete_clip without a region
only when they ask to remove a whole clip.
Use move_clip when the user asks to move, shift, slide, place, or put a clip
or selected region at a different time/bar.
Use deterministic edit actions for split, crop, duplicate, delete, and extract.

Rules:
- Do not invent track_id or clip_id. Use ids from context only.
- If the user says "this", "that section", "selected", or "here", target the selected clip/region.
- If the user names a track, target the matching track from context. If they
  mention "last N bars", set bars=N and target the last clip on that track.
- If you provide a region, use absolute timeline seconds, not clip-relative
  seconds and not bar numbers. Clamp the region to the target clip start/end.
- Bar numbers in user requests are 1-based: bar 1 starts at 0 seconds.
- For "bar N", use start=(N - 1) * seconds_per_bar and end=N * seconds_per_bar.
- For "bars A through B", "bars A to B", "bars A-B", "bar A-B", or
  "bars A - B", the dash separates the inclusive start and end bars. Use
  region.start=(A - 1) * seconds_per_bar and region.end=B * seconds_per_bar.
- For moving to bar N, set target_bar=N or target_start=(N - 1) *
  seconds_per_bar.
- Context fields named bar_start_number/bar_end_number are user-facing
  1-based bar numbers. Fields named barStart/barEnd are zero-based grid
  positions and are included only for precision.
- If an edit requires a selected clip or region and none exists, return ask_clarification.
- Preserve tempo/key unless the user explicitly asks to change the song feel.
- For generate_track, fill part, name, instrument, style, production when useful.
- For sa3_edit_region, fill prompt and noise; use the selected region.

Return this shape:
{{
  "actions": [
    {{
      "type": "generate_track | fill_region | compose_midi | regen_clip | regen_region | sa3_edit_region | split_clip | move_clip | duplicate_clip | delete_clip | delete_track | extract_region | crop_to_region | extend_clip | set_tempo_key | ask_clarification",
      "part": "bass | piano | guitar | drums | harmony | melody | mix | free",
      "name": "short name",
      "instrument": "full sound description",
      "style": "genre or playing style",
      "prompt": "edit or generation prompt",
      "midi": false,
      "track_id": null,
      "clip_id": null,
      "region": null,
      "target_start": null,
      "target_bar": null,
      "noise": 0.8,
      "bars": null,
      "bpm": null,
      "key": null,
      "mode": null,
      "production": "",
      "reason": ""
    }}
  ],
  "notes": ""
}}
"""


def _user_prompt(text: str, context: AgentRequestContext) -> str:
    compact_tracks = []
    for track in context.tracks[:16]:
        clips = track.get("clips") or []
        compact_tracks.append({
            "id": track.get("id"),
            "name": track.get("name"),
            "kind": track.get("kind"),
            "clips": [
                {
                    "id": clip.get("id"),
                    "start": clip.get("start"),
                    "duration": clip.get("duration"),
                    "end": (clip.get("start") or 0) + (clip.get("duration") or 0),
                    "barStart": clip.get("barStart"),
                    "barEnd": clip.get("barEnd"),
                    "bar_start_number": clip.get("bar_start_number"),
                    "bar_end_number": clip.get("bar_end_number"),
                    "bar_start_position": clip.get("bar_start_position"),
                    "bar_end_position": clip.get("bar_end_position"),
                    "startBar": clip.get("startBar"),
                    "offset": clip.get("offset"),
                    "part": clip.get("part"),
                    "prompt": clip.get("prompt"),
                }
                for clip in clips[:8]
            ],
        })
    payload = {
        "request": text,
        "session": {
            "id": context.session_id,
            "bpm": context.bpm,
            "key": context.key,
            "mode": context.mode,
            "backend": context.backend,
            "seconds_per_bar": context.seconds_per_bar,
            "playhead": context.playhead,
            "duration": context.duration,
        },
        "selection": {
            "track_id": context.selected_track_id,
            "clip_id": context.selected_clip_id,
            "region": context.selected_region,
        },
        "tracks": compact_tracks,
        "recent_actions": context.recent_actions[-8:],
    }
    return json.dumps(payload)


def _sanitize(plan: AgentPlan, context: AgentRequestContext) -> AgentPlan:
    track_ids = {t.get("id") for t in context.tracks}
    clip_ids = {c.get("id") for t in context.tracks for c in (t.get("clips") or [])}

    def clip_for(action: AgentAction) -> dict[str, Any] | None:
        for track in context.tracks:
            for clip in track.get("clips") or []:
                if clip.get("id") == action.clip_id:
                    return clip
        return None

    def last_clip_id_for_track(track_id: str | None) -> str | None:
        if not track_id:
            return None
        for track in context.tracks:
            if track.get("id") != track_id:
                continue
            clips = track.get("clips") or []
            return clips[-1].get("id") if clips else None
        return None

    def track_id_from_request(action: AgentAction) -> str | None:
        text = (context.original_request or "").lower()
        candidates: list[tuple[int, str]] = []
        for track in context.tracks:
            track_id = track.get("id")
            if not track_id:
                continue
            name = str(track.get("name") or "").lower()
            kind = str(track.get("kind") or "").lower()
            part = str(action.part or "").lower()
            if name and name in text:
                candidates.append((len(name), track_id))
            elif kind and kind in text:
                candidates.append((len(kind), track_id))
            elif part and (part == kind or part in name):
                candidates.append((len(part), track_id))
        if candidates:
            return sorted(candidates, reverse=True)[0][1]
        return context.selected_track_id

    def derive_timeline_region() -> dict[str, float] | None:
        seconds_per_bar = context.seconds_per_bar or 0
        requested_range = _requested_bar_range(context.original_request)
        if seconds_per_bar <= 0 or not requested_range:
            return context.selected_region
        start_bar, end_bar = requested_range
        return {
            "start": (start_bar - 1.0) * seconds_per_bar,
            "end": end_bar * seconds_per_bar,
        }

    def derive_region(action: AgentAction) -> dict[str, float] | None:
        seconds_per_bar = context.seconds_per_bar or 0
        if seconds_per_bar <= 0:
            return None
        clip = clip_for(action)
        requested_range = _requested_bar_range(context.original_request)
        if requested_range:
            start_bar, end_bar = requested_range
            start = (start_bar - 1.0) * seconds_per_bar
            end = end_bar * seconds_per_bar
        elif action.target_bar is not None and action.bars:
            start = (float(action.target_bar) - 1.0) * seconds_per_bar
            end = start + float(action.bars) * seconds_per_bar
        elif action.bars and clip:
            end = float((clip.get("start") or 0) + (clip.get("duration") or 0))
            start = end - float(action.bars) * seconds_per_bar
        else:
            return None
        if clip:
            clip_start = float(clip.get("start") or 0)
            clip_end = float((clip.get("start") or 0) + (clip.get("duration") or 0))
            start = max(clip_start, min(clip_end, start))
            end = max(clip_start, min(clip_end, end))
        if end <= start:
            return None
        return {"start": start, "end": end}

    clean: list[AgentAction] = []
    for action in plan.actions[:8]:
        if (
            action.type == "generate_track"
            and _is_fill_region_request(context.original_request)
            and not _is_new_track_request(context.original_request)
        ):
            action.type = "fill_region"
            action.track_id = action.track_id or track_id_from_request(action)
            action.region = action.region or derive_timeline_region()
        if action.type == "fill_region" and _is_new_track_request(context.original_request):
            action.type = "generate_track"
            action.track_id = None
            action.clip_id = None
            action.region = None
        if action.part and action.part not in PARTS:
            action.part = "free"
        if action.noise is not None:
            action.noise = max(0.0, min(1.0, action.noise))
        if action.bars is not None:
            action.bars = max(1, min(128, action.bars))
        if action.mode not in (None, "major", "minor"):
            action.mode = None
        if action.track_id and action.track_id not in track_ids:
            action.track_id = None
        if action.clip_id and action.clip_id not in clip_ids:
            action.clip_id = None
        if action.type in {"regen_clip", "split_clip", "move_clip", "duplicate_clip", "delete_clip"}:
            action.track_id = action.track_id or context.selected_track_id
            if not action.clip_id:
                if action.track_id == context.selected_track_id:
                    action.clip_id = context.selected_clip_id
                action.clip_id = action.clip_id or last_clip_id_for_track(action.track_id)
            if action.type in {"move_clip", "duplicate_clip", "delete_clip"} and not action.region:
                action.region = derive_region(action)
            if action.type in {"duplicate_clip", "delete_clip"} and not action.region:
                action.region = context.selected_region
            if action.type == "move_clip" and not action.region:
                action.region = context.selected_region
            if action.type == "move_clip":
                if action.target_bar is not None:
                    action.target_bar = max(1.0, min(512.0, action.target_bar))
                if action.target_start is not None:
                    action.target_start = max(0.0, action.target_start)
                if action.target_bar is None and action.target_start is None:
                    clean.append(AgentAction(
                        type="ask_clarification",
                        reason="Tell me which bar or time to move it to.",
                    ))
                    continue
        if action.type in {"move_clip", "duplicate_clip", "delete_clip"} and not action.clip_id:
            clean.append(AgentAction(
                type="ask_clarification",
                reason="Select a clip or name the clip/track to edit.",
            ))
            continue
        if action.type == "delete_track":
            action.track_id = action.track_id or context.selected_track_id
            if not action.track_id:
                clean.append(AgentAction(
                    type="ask_clarification",
                    reason="Select or name the track to delete.",
                ))
                continue
        if action.type == "fill_region":
            action.track_id = action.track_id or track_id_from_request(action)
            action.region = action.region or derive_timeline_region()
            if not action.track_id:
                clean.append(AgentAction(
                    type="ask_clarification",
                    reason="Tell me which track to fill.",
                ))
                continue
            if not action.region:
                clean.append(AgentAction(
                    type="ask_clarification",
                    reason="Tell me which bars or select a gap to fill.",
                ))
                continue
        if action.type == "extend_clip":
            action.track_id = action.track_id or context.selected_track_id
            if not action.clip_id:
                if action.track_id == context.selected_track_id:
                    action.clip_id = context.selected_clip_id
                action.clip_id = action.clip_id or last_clip_id_for_track(action.track_id)
        if action.type in {"regen_region", "sa3_edit_region", "extract_region", "crop_to_region"}:
            action.track_id = action.track_id or context.selected_track_id
            if not action.clip_id:
                if action.track_id == context.selected_track_id:
                    action.clip_id = context.selected_clip_id
                action.clip_id = action.clip_id or last_clip_id_for_track(action.track_id)
            action.region = action.region or derive_region(action) or context.selected_region
        if action.type in {"sa3_edit_region", "regen_region", "extract_region", "crop_to_region"} and not action.region:
            clean.append(AgentAction(
                type="ask_clarification",
                reason="Select a region on a clip first.",
            ))
            continue
        clean.append(action)
    plan.actions = clean
    return plan


def _requested_bar_range(text: str) -> tuple[float, float] | None:
    match = re.search(
        r"\bbars?\s+(\d+(?:\.\d+)?)\s*(?:-|–|—|\bto\b|\bthrough\b|\band\b)\s*(?:bars?\s*)?(\d+(?:\.\d+)?)\b",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    start = float(match.group(1))
    end = float(match.group(2))
    if start <= 0 or end <= 0 or start == end:
        return None
    if end < start:
        start, end = end, start
    return start, end


def _is_fill_region_request(text: str) -> bool:
    return bool(re.search(
        r"\b(fill|patch|replace|generate|make|create)\b.*\b(gap|space|hole|silence|empty|between|bars?)\b",
        text,
        flags=re.IGNORECASE,
    ))


def _is_new_track_request(text: str) -> bool:
    return bool(re.search(
        r"\b(new|another|separate|additional)\b[^.?!]{0,40}\b(track|layer|instrument|row)\b|\b(add|create|generate)\b[^.?!]{0,40}\bnew\b[^.?!]{0,40}\b(track|layer|instrument|row)\b",
        text,
        flags=re.IGNORECASE,
    ))


def _fallback_plan(text: str, context: AgentRequestContext) -> AgentPlan:
    legacy_context = interpret.Context(
        bpm=context.bpm,
        key=context.key,
        mode=context.mode,
        existing_parts=[t.get("name", "") for t in context.tracks],
    )
    legacy = interpret.interpret(text, legacy_context)
    actions = [
        AgentAction(
            type="compose_midi" if track.midi else "generate_track",
            part=track.part,
            name=track.name,
            instrument=track.instrument,
            style=", ".join(piece for piece in (legacy.style, track.style) if piece),
            midi=track.midi,
            bars=legacy.bars,
            bpm=legacy.bpm,
            key=legacy.key,
            mode=legacy.mode,
            production=legacy.production,
        )
        for track in legacy.tracks
    ]
    return AgentPlan(actions=actions, notes=legacy.notes)
