import os
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pymongo.errors import DuplicateKeyError, ServerSelectionTimeoutError

from . import agent, asr, db

Mode = Literal["note", "ask"]


class Ctx(BaseModel):
    chapter_id: str | None = None   # required for mode=note
    scope: Literal["chapter", "subject", "all"] = "chapter"  # default scope for mode=ask
    speak_lang: str | None = None   # ASR language code the student speaks (hi, bn, ta...); None = auto-detect
    answer_lang: str | None = None  # e.g. "Hindi", "Tamil", "Hinglish ..."; None = reply in the language spoken
    source: dict | None = None      # {type: web|book, url, title, t, selection, ref}


class TextIn(BaseModel):
    text: str
    mode: Mode
    ctx: Ctx = Ctx()
    intent: Literal["ask", "summary", "flashcards", "quiz"] | None = None  # quick-action buttons skip routing


class Name(BaseModel):
    name: str


@asynccontextmanager
async def lifespan(_):
    threading.Thread(target=asr.warmup, daemon=True).start()  # first voice note shouldn't pay the model load
    threading.Thread(target=db.init_when_reachable, daemon=True).start()  # indexes; never blocks startup
    yield


app = FastAPI(title="Vaani Notes", lifespan=lifespan)


@app.exception_handler(DuplicateKeyError)
def _duplicate(_, __):
    return JSONResponse({"detail": "That name already exists."}, status_code=409)


@app.exception_handler(ServerSelectionTimeoutError)
def _db_down(_, __):
    return JSONResponse({"detail": "The server can't reach MongoDB Atlas. In Atlas > Network Access, allow this "
                                   "machine's current IP address (it changes when you switch networks)."}, status_code=503)


@app.exception_handler(LookupError)
def _missing(_, e):
    return JSONResponse({"detail": str(e)}, status_code=404)


def _chapter(c):
    ch = db.chapter(c.chapter_id)
    if not ch:
        raise HTTPException(400, "Pick a chapter before adding a note.")
    return ch


@app.post("/api/voice")
def voice(bg: BackgroundTasks, audio: UploadFile, mode: Mode = Form(...), ctx: str = Form("{}")):
    c = Ctx.model_validate_json(ctx)
    ch = _chapter(c) if mode == "note" else None
    with tempfile.NamedTemporaryFile(suffix=Path(audio.filename or "a.webm").suffix, delete=False) as f:
        f.write(audio.file.read())
    if mode == "note":  # answer at once; transcription and structuring continue in the background
        nid = db.add_pending(ch, c.source, "transcribing")
        bg.add_task(agent.process_note, nid, c.speak_lang, f.name)
        return {"status": "processing", "id": nid}
    try:
        text, lang = asr.transcribe(f.name, c.speak_lang)
    finally:
        os.unlink(f.name)
    if not text.strip():
        return {"status": "empty", "transcript": "", "answer": "Didn't catch that, try again."}
    return agent.ask(text, lang, c.model_dump())


@app.post("/api/text")
def text(body: TextIn, bg: BackgroundTasks):
    if body.mode == "note":
        nid = db.add_pending(_chapter(body.ctx), body.ctx.source, "structuring", transcript=body.text)
        bg.add_task(agent.process_note, nid)
        return {"status": "processing", "id": nid}
    return agent.ask(body.text, None, body.ctx.model_dump(), body.intent)


@app.get("/api/notes/{nid}")
def note(nid: str):
    found = db.notes(ids=[nid], include_pending=True)
    if not found:
        raise HTTPException(404, "note not found")
    return found[0]


@app.post("/api/notes/{nid}/retry")
def retry(nid: str, bg: BackgroundTasks):
    doc = db.raw(nid)
    if not doc or doc.get("stage") != "failed":
        raise HTTPException(409, "Only failed notes can be retried.")
    if not doc.get("transcript"):
        raise HTTPException(409, "Nothing was transcribed, so please record it again.")
    db.update(nid, stage="structuring")
    bg.add_task(agent.process_note, nid)
    return {"status": "processing", "id": nid}


@app.get("/api/tree")
def tree():
    return db.tree()


@app.post("/api/subjects")
def add_subject(b: Name):
    return {"id": db.add_subject(_name(b))}


@app.post("/api/subjects/{sid}/chapters")
def add_chapter(sid: str, b: Name):
    return {"id": db.add_chapter(sid, _name(b))}


@app.get("/api/chapters/{cid}/notes")
def chapter_notes(cid: str):
    return db.notes(chapter_id=cid, include_pending=True)


@app.delete("/api/{kind}s/{id_}")
def delete(kind: Literal["subject", "chapter", "note"], id_: str):
    if not db.delete(kind, id_):
        raise HTTPException(404, f"{kind} not found")
    return {"deleted": id_}


def _name(b):
    if not b.name.strip():
        raise HTTPException(400, "Name can't be empty.")
    return b.name


app.mount("/", StaticFiles(directory=Path(__file__).resolve().parents[2] / "dashboard", html=True))
