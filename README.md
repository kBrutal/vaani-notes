# Vaani Notes

Speak what you just understood, in any Indian language or mixed with English. You get a structured,
linked note filed under Subject › Topic. You can then ask questions about your notes, or get flashcards
and quizzes in the language you choose. See [PLAN.md](PLAN.md).

```
backend/    FastAPI: asr.py (indic-transcribe-core), llm.py (NVIDIA), agent.py (routing + prompts), db.py (MongoDB Atlas), main.py (API)
dashboard/  static web app served by the backend at http://localhost:8000
extension/  Chrome MV3 side panel: voice capture while studying in the browser
```

## Run

1. On https://huggingface.co/bodhan-ai/indic-transcribe-core, accept the gated-model terms with your HF account.
2. Copy `.env.example` to `.env` and fill in `NVIDIA_API_KEY`, `HF_TOKEN` (a read token from the same account)
   and the MongoDB Atlas settings (`MONGODB_URI`, `MONGODB_DB`). In Atlas, allow your IP under Network Access.
   The vector search index is created automatically on first start.

```bash
cd backend
python3.10 -m venv .venv && source .venv/bin/activate   # 3.10 is what the model card suggests
pip install -r requirements.txt
set -a; source ../.env; set +a
python -m app.asr download             # one-time ~4.9 GB into backend/models/, never re-downloaded
python -m app.asr some_clip.webm hi     # prints (text, lang)
uvicorn app.main:app --reload --env-file ../.env
```

Open http://localhost:8000. Create a subject and its chapters in the sidebar, pick a chapter, then press
**Add note by voice** (Alt+N) and explain the concept. The topic is assigned automatically. Ask questions,
or get summaries, flashcards and quizzes, from the right-hand panel (Alt+A to ask by voice).
Press **Start listening** once: the mic stays on while you study, and everything you explain is drafted into
notes. To ask a doubt, say **"Question Vaani"** and then the question; a 4-second pause ends it. Note-taking
waits while the answer appears in the chat, then carries on with the same note. If you say a statement and
then "Question Vaani …" in one breath, the statement still goes to your notes. Start it with **"Question Vaani"** to be sure it's treated as a
question ("Question Vaani, procedure established by law aur due process mein kya farak hai?"). The study agents recognise it as a question, answer it in the chat using your notes and the web,
handle follow-ups, and go back to note-taking when you say "ok, got it".
Speak any Indian language, English, or a mix. The language is detected for every recording, so there's
no language setting.

Notes, chapters and embeddings live in MongoDB Atlas. Semantic search uses Atlas Vector Search on the same
`notes` collection, so there is no separate vector database.

## Chrome extension

1. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `extension/`.
2. Allow the microphone in the tab that opens. Side panels can't ask for it themselves.
3. Pin Vaani and open it with the toolbar icon or **Alt+Shift+N**.

Then:
- **Note tab:** pick or create a chapter, tap the mic and explain. The video pauses while you talk and resumes
  afterwards, and the page, the video timestamp and any selected text are attached as the source. The chapter's
  recent notes show live progress, with Retry if something fails.
- **Alt+Shift+R** on any page starts or stops a voice note, opening the panel if needed.
- **Right-click selected text → Save to Vaani as a note** files it in the current chapter.
- **Ask tab:** questions, Summary, Flashcards and Quiz, scoped to the chapter, the subject or all notes.
- **Settings (gear icon):** server URL (for a deployed backend) and the reply language.
  Change the shortcuts at `chrome://extensions/shortcuts`.

## Test

```bash
# uses and then drops a throwaway database; never point it at your real one
cd backend && set -a && source ../.env && set +a && MONGODB_DB=vaani_test python -m tests.test_db
```
