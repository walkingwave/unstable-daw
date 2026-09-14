"""On-disk session storage.

One directory per session, holding the vocal, the guides, the stems, the
MIDI, and a meta.json recording how each stem was produced. That manifest
is the provenance record: prompt, backend, seed and noise are enough to
reproduce any stem exactly.

    sessions/<uuid>/
      vocal.wav
      meta.json
      guides/bass.wav
      stems/bass.wav
      midi/bass.mid
"""

from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import SAMPLE_RATE, SESSIONS_DIR
from .models import Analysis, Arrangement, StemResult
from .melody import Note

SESSION_ID_RE = re.compile(r"^[0-9a-f]{12}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Session:
    """A working directory plus the analysis and stems produced in it."""

    id: str
    root: Path

    # --- lifecycle -----------------------------------------------------

    @classmethod
    def create(cls, vocal: np.ndarray, sr: int) -> "Session":
        session_id = uuid.uuid4().hex[:12]
        session = cls(id=session_id, root=SESSIONS_DIR / session_id)

        for subdir in ("guides", "stems", "midi", "uploads"):
            (session.root / subdir).mkdir(parents=True, exist_ok=True)

        sf.write(session.vocal_path, vocal, sr)
        now = _now()
        session._write_meta({
            "id": session_id, "analysis": None, "stems": {},
            "created_at": now, "updated_at": now, "display_name": f"Untitled — {now[:19]}",
        })
        return session

    @classmethod
    def load(cls, session_id: str) -> "Session":
        if not SESSION_ID_RE.fullmatch(session_id):
            raise FileNotFoundError(f"no such session: {session_id}")
        root = SESSIONS_DIR / session_id
        if not root.is_dir():
            raise FileNotFoundError(f"no such session: {session_id}")
        return cls(id=session_id, root=root)

    # --- paths ---------------------------------------------------------

    @property
    def vocal_path(self) -> Path:
        return self.root / "vocal.wav"

    @property
    def meta_path(self) -> Path:
        return self.root / "meta.json"

    # Keyed by track name, not part. A session can hold several tracks
    # built on the same part - a xylophone and a piano are both "piano" to
    # the arranger - and keying by part would silently overwrite them.
    def guide_path(self, track: str) -> Path:
        return self.root / "guides" / f"{track}.wav"

    def stem_path(self, track: str) -> Path:
        return self.root / "stems" / f"{track}.wav"

    def midi_path(self, track: str) -> Path:
        return self.root / "midi" / f"{track}.mid"

    def upload_path(self, filename: str) -> Path:
        return self.root / "uploads" / filename

    # --- audio ---------------------------------------------------------

    def read_vocal(self) -> tuple[np.ndarray, int]:
        audio, sr = sf.read(self.vocal_path, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        return audio, sr

    def read_stems(
        self,
        exclude: str = "",
        limit: int | None = None,
        skip_parts: tuple[str, ...] = (),
    ) -> list[tuple[str, np.ndarray]]:
        """Finished stems as mono audio, oldest first.

        Used to give a new part the ones already on the timeline as context,
        so it is generated against the band rather than in a vacuum.

        `limit` keeps only the most recent N. A session accumulates every
        take a user tried — a rave experiment, a jazz one, three versions of
        the drums — and handing all of them to the model as "the band" is
        worse than handing it nothing. The newest few are the ones the user
        is actually working with.

        Silent stems are skipped: they contribute nothing but do count
        against the limit, so a dead take could otherwise crowd out a live
        one.
        """
        names = list(self._read_meta().get("stems") or {})
        out: list[tuple[str, np.ndarray]] = []
        for name in reversed(names):  # newest first while filling the quota
            if name == exclude:
                continue
            meta = (self._read_meta().get("stems") or {}).get(name) or {}
            if meta.get("part") in skip_parts:
                continue
            path = self.stem_path(name)
            if not path.is_file():
                continue
            audio, _ = sf.read(path, dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if not audio.size or float(np.abs(audio).max()) < 1e-4:
                continue
            out.append((name, audio))
            if limit is not None and len(out) >= limit:
                break
        return list(reversed(out))

    def write_audio(self, path: Path, audio: np.ndarray) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(path, audio, SAMPLE_RATE)

    # --- metadata ------------------------------------------------------

    def _read_meta(self) -> dict:
        return json.loads(self.meta_path.read_text())

    def _write_meta(self, meta: dict) -> None:
        meta["updated_at"] = _now()
        self.meta_path.write_text(json.dumps(meta, indent=2))

    def set_display_name(self, name: str) -> None:
        meta = self._read_meta()
        meta["display_name"] = name.strip()[:80] or meta.get("display_name", "Untitled")
        self._write_meta(meta)

    def summary(self) -> dict:
        meta = self._read_meta()
        stat = self.root.stat()
        analysis = meta.get("analysis") or {}
        return {
            "id": self.id,
            "display_name": meta.get("display_name", f"Session {self.id}"),
            "created_at": meta.get("created_at"),
            "updated_at": meta.get("updated_at") or datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "analysis": None if not analysis else {
                "bpm": analysis.get("bpm"), "key": analysis.get("key"),
                "mode": analysis.get("mode"), "bars": len(analysis.get("bars", [])),
            },
            "style": (meta.get("arrangement") or {}).get("style", ""),
            "track_names": sorted((meta.get("stems") or {}).keys()),
        }

    def delete(self) -> None:
        root = self.root.resolve()
        parent = SESSIONS_DIR.resolve()
        if root.parent != parent or self.root.is_symlink():
            raise ValueError("invalid session path")
        shutil.rmtree(root)

    @property
    def analysis(self) -> Analysis:
        meta = self._read_meta()
        if meta.get("analysis") is None:
            raise ValueError(f"session {self.id} has not been analyzed yet")
        return Analysis.from_dict(meta["analysis"])

    def save_analysis(self, analysis: Analysis) -> None:
        meta = self._read_meta()
        meta["analysis"] = analysis.to_dict()
        self._write_meta(meta)

    def save_hum_notes(self, notes: list[Note], tracking: dict | None = None) -> None:
        """Persist note events and bounded tracker provenance for reproduction."""
        meta = self._read_meta()
        meta["hum_notes"] = [
            {"pitch": note.pitch, "start": note.start, "end": note.end} for note in notes
        ]
        if tracking is not None:
            meta["pitch_tracking"] = tracking
        self._write_meta(meta)

    @property
    def hum_notes(self) -> list[Note]:
        return [Note(**note) for note in self._read_meta().get("hum_notes", [])]

    @property
    def arrangement(self) -> Arrangement:
        """Session-wide style and length. Empty until the first generation."""
        return Arrangement.from_dict(self._read_meta().get("arrangement"))

    def save_arrangement(self, arrangement: Arrangement) -> None:
        meta = self._read_meta()
        meta["arrangement"] = arrangement.to_dict()
        self._write_meta(meta)

    def save_stem(self, result: StemResult) -> None:
        meta = self._read_meta()
        meta["stems"][result.name] = result.to_dict()
        self._write_meta(meta)

    def save_transform(self, name: str, transform: dict) -> None:
        """Persist MIDI-only output separately from audio stems."""
        meta = self._read_meta()
        meta.setdefault("transforms", {})[name] = transform
        self._write_meta(meta)

    @property
    def timeline(self) -> dict | None:
        return self._read_meta().get("timeline")

    def save_timeline(self, timeline: dict) -> dict:
        meta = self._read_meta()
        meta["timeline"] = timeline
        self._write_meta(meta)
        return meta["timeline"]

    def operations(self, limit: int = 100) -> list[dict]:
        ops = self._read_meta().get("operations") or []
        return ops[-limit:]

    def record_operation(self, operation: dict) -> dict:
        meta = self._read_meta()
        ops = meta.setdefault("operations", [])
        entry = {
            "id": uuid.uuid4().hex[:12],
            "created_at": _now(),
            **operation,
        }
        ops.append(entry)
        # Keep meta.json bounded; this is history for agent context, not an
        # audit log that needs to grow forever.
        meta["operations"] = ops[-200:]
        self._write_meta(meta)
        return entry

    def to_dict(self) -> dict:
        return self._read_meta()
