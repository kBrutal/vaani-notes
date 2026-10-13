# Vaani Notes: implementation plan

A voice notetaker for students. Mid-study, the student speaks a concept and their own understanding of it, in
any Indian language or mixed with English. The agent turns that into a structured note, files it under
Subject › Topic, and links it to related notes. Later the student can ask questions, generate flashcards or
quizzes, and choose the reply language.

## 1. Architecture

```
 Chrome extension (side panel)          Dashboard (web, served by backend)
  - mic, Alt+Shift+N                     - mic + typed input (books / offline study)
  - captures URL, title, selection,      - Subject › Topic tree, notes, links
    video timestamp, pauses video        - Q&A, flashcards, quiz, reply-language picker
            │                                       │
            └──────────── HTTP (localhost:8000/api) ┘
                               │
                       FastAPI backend
   audio ─► 16 kHz mono wav (PyAV) ─► ASR: bodhan-ai/indic-transcribe-core (local, HF-gated)
   text  ─► Agent: 1 routing LLM call  ─► save_note | ask | flashcards | quiz
                   │                         │
                   │ (unsure / new topic) ─► "confirm" ─► student picks place ─► save
                   ▼
           NVIDIA API: chat (Llama-3.3-70B by default) + multilingual embeddings
                   ▼
           MongoDB Atlas: subjects ─< chapters ─< notes (topic, links, embedding) + $vectorSearch
```

## 2. Model choices (open-source audio, NVIDIA for LLM)

| Job | Default | Why | Swap to |
|---|---|---|---|
| ASR | **bodhan-ai/indic-transcribe-core** (Canary-1B-v2 fine-tune, Indic Open Model License, gated) | 27 Indian languages + Indian English, transcribes code-mixed speech as spoken. English words come out transliterated into the native script. Has language ID, and a long-form helper splits audio at pauses and breaks decode loops | AI4Bharat IndicConformer as an eval baseline (`ASR_MODEL` only swaps checkpoints with the same code layout) |
| LLM | NVIDIA API Catalog, `nvidia/nemotron-3-super-120b-a12b` | Picked from 4 catalog models on a Hinglish note: fastest (6 s), correct tags, caught a planted factual error. (Llama-3.3-70B was retired 2026-08-26) | Any catalog model via `CHAT_MODEL`. Benchmark the Indic-tuned and Nemotron models in the catalog against your eval set |
| Embeddings | NVIDIA `nvidia/nemotron-3-embed-1b` | Cross-lingual: a Hindi query scored 0.65 against the English Article 21 note and 0.16 against an unrelated one | Local `BAAI/bge-m3` if you want this offline |
| TTS (Phase 3) | **AI4Bharat Indic Parler-TTS** | Open, 20+ Indian languages, can speak answers aloud | – |

Confirm the exact model IDs on build.nvidia.com when you create the key. The catalog changes.

## 3. Key design decisions

- **Notes are stored in English, and the verbatim transcript is kept too.** One canonical language keeps
  linking and dedup reliable. The student's own words are never lost ("What you said"), and any answer,
  flashcard or quiz is generated in the chosen language at read time.
- **The agent never adds facts to a note.** If the student says something wrong, it goes in `flags` with the
  correction, and the note stays theirs. This matters for UPSC, where misconceptions are expensive.
- **The student picks the chapter, the agent picks the topic.** Classifying chapters automatically caused
  mistakes, so subjects and chapters are created and selected by the student. The agent only places a note
  under a topic inside that chapter, reusing existing topic names.
- **Explicit modes:** "Add note" and "Ask" are separate buttons, so the agent never has to guess whether
  the student is saving or asking.
- **Linking = embedding similarity ≥ `LINK_MIN`, across subjects.** Polity↔History links are useful for
  UPSC. Links are bidirectional and shown on each note.
- **Query scope:** subject+topic → whole chapter (capped at 40 notes); otherwise vector top-12, optionally
  within a subject.
- **Push-to-talk, not a wake word.** It's more reliable and private, and the hotkey is enough.
- **No server session state.** A "confirm" response carries the pending note back to the client.

## 3b. Agents (`backend/app/agents.py`, `tools.py`)

One stream of speech; the agents decide what each part of it is.

**Continuous listening** (`dashboard/listen.js`, same file in `extension/`): the mic stays on, an energy VAD
against the room's noise floor cuts speech at 4 s pauses (time to think mid-question; trailing silence is
trimmed before upload), and each piece goes to the session as a 16 kHz WAV.

**Questions are wake-phrase only:** everything is a note unless the student says "Question Vaani". What comes
after it is the question (said on its own, the next piece is the question); what came before it is still
note. No LLM guesses note-vs-question any more. Note parts are drafted into one note (`NoteTaker`): a question
does NOT close the draft, so note-taking resumes after the answer with the same context; the draft is saved
after 20 s without notes, at 250 words, on a chapter switch or when listening stops. Questions are answered in
the background (`answer_id`, polled); the client holds note-taking (and pauses the video) until the answer is
shown; anything said meanwhile is held and processed afterwards, never dropped. Drafts with nothing worth
noting (filler) are deleted quietly.

| Agent | Job |
|---|---|
| `StudySession` | Orchestrator for one sitting: chapter, current page (title, URL, video time, selection), recent notes, the conversation, and the mode (`notetaking` / `conversation`) |
| `RouterAgent` | Labels each utterance `note` / `question` (incl. follow-ups, rewritten as a standalone question) / `end` ("ok got it") / `summary` / `flashcards` / `quiz` |
| `TutorAgent` | Answers doubts conversationally (TTS-ready: 2–5 sentences, no markdown) in the student's language, using the session context and tools |
| `NoteTaker` | Hands notes to the background pipeline (transcribe → distil → link) |

`Agent` is the shared base: a system prompt, tools, and a bounded native tool-calling loop on the NVIDIA
model (at most 4 tool rounds, then it must answer). Tools are plain functions plus a JSON schema
(`Tool`): `search_notes` (Atlas Vector Search over the student's notes, scoped to the chapter, subject or
all) and `web_search` (DuckDuckGo, no key). Sources shown in the UI are only ones a tool actually returned.

**Lecture capture (extension):** `chrome.tabCapture` gives the tab's audio to the same listener (played back so
it stays audible; 1.5 s pauses, since the lecturer's speech is drafted anyway). `POST /api/session/{sid}/lecture`
transcribes each piece into a separate lecture draft (~600 words per note, origin "lecture" in the note prompt,
source = page + the video time the piece started). The last ~1500 characters of lecture transcript go to the
tutor as `lecture_just_said`. While capturing, mic speech without "Question Vaani" is ignored (it would hear
the lecture through the speakers).

**Early wake:** the listener peeks at the first 2.5 s of every stretch of speech (`onPeek`) and sends it to
`POST /api/wake` (English-mode decode; Hindi-mode retry when it hears "Question…" but not "Vaani"). On a hit
the extension pauses the video and lecture capture at once (~3.5-4 s after the student starts speaking), so
the rest of the question is recorded without the lecture; it resumes when the answer is shown, or straight
away if the full transcript isn't a question.

**Spoken language, per recording (no setting):** indic-transcribe's language ID picks the language. It is
near-perfect for Bengali, Tamil, Telugu, Malayalam, Kannada and Hindi, but plain Indian-accented English lands
in a Hindi-belt class with low confidence. So Hindi or an unsure Hindi-belt guess is transcribed as Hindi;
if that transcript has no common Hindi words it was English, and is re-transcribed in English. Code-mixed
speech keeps its Indic language. Then: wake phrase "Question Vaani" (forces a question), then the router.

**Reply language** is one rule for every answer path (tutor, note answers, summaries, "got it"
acknowledgements): the student's "Reply in" choice, else the language they used, decided in code
(`routing.spoken_language`: ASR language code, then script, then Hinglish function words). The script of each
reply is checked in code (`routing.in_language`), and a reply in the wrong language or script is rewritten
once (`agent.ensure_language`).

API: `POST /api/session/{sid}/voice|text` (`expect: auto` from the main mic, `question` from the ask box),
`POST /api/session/{sid}/end`. Sessions live in memory for 3 h (lost on restart; persist in Mongo later).

**Next:** TTS for replies (Indic Parler-TTS) and hands-free follow-ups; more tools (fetch a page, the video
transcript at the current timestamp, save a Q&A as a note).

## 4. Data model (`backend/app/db.py`, MongoDB Atlas)

- `subjects {name}` → `chapters {subject_id, name}`. Names are unique and case-insensitive (collation index).
- `notes {subject_id, chapter_id, topic, title, summary, key_points[], flags[], transcript, lang, source,
  embedding[2048], links[{id, score}], created_at}`.

**The student creates subjects and chapters. The agent assigns `topic`**, which is a plain field, so a topic
disappears with its last note. Links are stored on both notes and removed when either note is deleted.
Deletes cascade.

**Notes are saved before they're processed.** A shell with `stage` is stored as soon as the student stops
talking; a background task transcribes, structures and links it, updating `stage` for the UI's progress steps.
A failure keeps the transcript for a retry. Unfinished notes are excluded from counts, topics, search and answers.

**Topic summaries** (`topics {chapter_id, name, summary, note_ids}`) are refreshed in the background after each
note and rebuilt on demand when their `note_ids` no longer match the topic's notes. Chapter/subject summaries
are built from them, so they cover every topic regardless of size. Quizzes and flashcards sample up to 40 notes
round-robin across topics, and the reply shows the coverage when sampled.

**RAG uses Atlas Vector Search** (`$vectorSearch`) on `notes.embedding` (index `note_vectors`, dotProduct,
pre-filters on `subject_id` and `chapter_id`), in the same database as the notes, with no separate vector DB.
The index is created on startup. Atlas reports the score as (1 + cosine) / 2, and `db.similar` converts it
back to cosine so `LINK_MIN` stays in cosine terms.

## 5. API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/voice` | multipart `audio` + `mode` (note/ask) + `ctx` JSON. `note`: returns `{id}` at once, processing continues in the background. `ask`: ASR → answer |
| POST | `/api/text` | `{text, mode, ctx, intent?}`. `note`: returns `{id}` at once. `ask`: keyword routing (no LLM call), or `intent` from the quick buttons |
| GET | `/api/notes/{id}` | one note, incl. `stage` (transcribing/structuring/linking/failed) while processing |
| POST | `/api/notes/{id}/retry` | re-run a failed note from its saved transcript |
| GET | `/api/tree` | subjects → chapters → topics, with note counts |
| POST | `/api/subjects`, `/api/subjects/{id}/chapters` | create (409 on duplicate name) |
| GET | `/api/chapters/{id}/notes` | notes with related links |
| DELETE | `/api/subjects/{id}`, `/api/chapters/{id}`, `/api/notes/{id}` | delete (cascades) |

`ctx = {chapter_id, scope: chapter|subject|all, speak_lang, answer_lang, source}`. For `mode=note`, a
`chapter_id` is required. For `mode=ask`, a chapter or subject the student names overrides `scope`.

## 6. Phases

**Phase 0: scaffold (done).** End-to-end loop works locally. DB test and a stubbed API smoke test pass.

**Phase 1: make capture trustworthy (1–2 wks)**
1. Record about 40 real clips: Hindi, Hinglish, Bengali, Tamil, Marathi, plus English-heavy, with
   UPSC jargon ("Article 21", "Kesavananda Bharati", "DPSP"). Write reference transcripts.
2. Measure WER and the share of notes that are correct, both with `speak_lang` set and with auto language ID.
   Run IndicConformer on the same clips as a baseline.
3. Tune `LINK_MIN` on about 50 real notes.
4. Add note edit / move / delete in the dashboard.
5. Dedup: if a new note's similarity is > ~0.9, offer "update existing note?" instead of adding a copy.

**Phase 2: revision features (2 wks)**
1. Spaced repetition: a `reviews(note_id, due, ease)` table with SM-2. Flashcards come from due notes.
2. Save quiz attempts, then show weak topics on the dashboard.
3. A "show this note in <language>" toggle (LLM translate, cached per note+lang).
4. Seed existing notes: paste text or upload a PDF, then run it through the same structuring prompt.
5. Concept graph view of links.

**Phase 3: voice-first and multi-user**
1. Spoken answers with Indic Parler-TTS. Streaming ASR for live partial transcripts.
2. Auth and per-user data (add `user_id` to every document and to the vector index filters).
3. Deploy: GPU box for ASR (a T4-class GPU is enough for a 1B model), backend behind HTTPS, extension pointed at it.
   Narrow the extension's `host_permissions` before publishing to the Chrome Web Store.

## 7. Risks

- **Code-mixed ASR quality** is the biggest risk. The Phase 1 eval addresses it before any other work.
  The router prompt already tells the LLM to repair ASR errors in technical terms.
- **Script of English terms:** English words come back in Devanagari, and the output-mode switch had no effect
  in testing. The LLM maps them back; check this in the Phase 1 eval.
- **Language ID files Indian-accented English under Hindi-belt languages.** Handled by the Hindi-word check; other Indic + English mixes still need real-voice testing.
- **CPU latency:** a 1B-parameter model on a laptop CPU is slow. Run ASR on a GPU for real use.
- **LLM JSON drift:** the code slices the outermost `{…}`. If a chosen model misbehaves, add one retry.
- **Wrong subject/topic:** the confirm dialog plus the Phase 1 move-note feature contain the damage.
