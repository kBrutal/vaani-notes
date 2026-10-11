"""The voice agent. Two explicit modes, chosen by the button the student pressed:
  note: utterance -> structured note, auto-filed under a topic of the chapter the student picked.
        Runs in the background (process_note) so the student never waits and never loses what they said.
  ask:  utterance -> answer | flashcards | quiz | summary, from the student's own notes
"""
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

from . import asr, db, llm
from .routing import in_language, route_typed, script_of, spoken_language, spread

log = logging.getLogger("vaani")
LINK_MIN = float(os.getenv("LINK_MIN", "0.4"))  # ponytail: tuned on 5 Polity notes for nemotron-3-embed-1b (related ~0.4+, unrelated ~0.2-0.3); retune on real data
MAX_NOTES = 40   # notes per LLM request; bigger scopes are sampled across topics (quiz) or summarised per topic
TOPIC_MAX = 60   # ponytail: notes per topic summary; chunk the topic if one ever grows past this

ASR_HINT = """The student speaks any Indian language, often mixed with English (Hinglish, Tanglish, Benglish...).
Voice input comes from an Indic ASR model: it is in the native script, English words appear transliterated
(e.g. "आर्टिकल इक्कीस" = "Article 21", "राइट टू लाइफ" = "right to life"), numbers may be spelt out as words,
and there may be recognition errors. Infer the intended words, especially technical terms, names and numbers."""

NOTE = ASR_HINT + """

The student is studying {subject} > {chapter} and just spoke about what they read or understood: often
thinking aloud, repeating themselves, reading lines out, with filler ("so basically", "I am studying about").
Distil it into a crisp study note that keeps only what is worth revising, and file it under a topic.
Existing topics in this chapter: {topics}

Return ONLY a JSON object:
{{"topic": "...",
  "note": {{"title": "short concept name",
            "summary": "the core idea in 1-2 sentences",
            "key_points": ["3-7 short, exam-ready points"],
            "flags": ["the correct fact, for anything wrong or doubtful in the input"]}}}}

Rules:
- topic: a sub-section of the chapter, broader than one concept, like a textbook sub-heading
  (chapter "Fundamental Rights" -> topic "Right to Freedom (Art. 19-22)"). Reuse an existing topic name
  exactly whenever the concept fits it.
- Write it like a textbook revision note: direct, neutral statements of fact in English. Never mention the
  student, "you" or "I", and never describe the input ("The student explains...", "They note...", "As
  mentioned..."). Write "Article 32 is a Fundamental Right", not "The student explains that Article 32...".
- Extract, don't transcribe. Keep what an examiner would ask about: definitions, article/section numbers,
  case names and what they held, dates, amendments, lists (e.g. the 6 freedoms), distinctions and exceptions.
  Drop filler, repetition, the student's process ("I read that...", "Laxmikanth chapter 7"), remarks like
  "this is important for the exam", and anything that is just restated.
  Each key point is one fact in at most ~15 words, scannable (fragments are fine: "Art 13: laws inconsistent
  with FRs void to that extent"). Keep a list together in one point ("6 freedoms: speech, assembly, ...").
  No two points may say the same thing, and don't repeat the summary in the key points.
- Complete over the input: every exam-relevant fact the student stated (who it applies to, exceptions,
  what changed and from what, numbers) must survive into a key point.
- Every fact must come from the input (plus page_selection if present). Never add facts, even true and
  relevant ones: don't complete a partial list, don't add clause/amendment numbers, dates, cases, grounds or
  tests the input didn't mention. If the student said "property was removed", write exactly that, not
  "removed by the 44th Amendment, 1978". A short, faithful note beats an encyclopaedic one.
- Mistakes: if any detail in the input is wrong (a date, number, name, article, case), leave that detail
  out of the note entirely (don't write the wrong value, don't write the corrected value) and ALWAYS add a
  flag giving the correct fact in the same neutral voice: "Kesavananda Bharati was decided in 1973, not
  1975." Never silently fix a mistake. If nothing is wrong, flags is [].
- If there is no study content at all (noise, "hello"), return {{"topic": null, "note": null}}."""

ASK = ASR_HINT + """

The student is asking about their own notes. Their library (subject > chapter > topics):
{library}

Return ONLY a JSON object:
{{"intent": "ask" | "flashcards" | "quiz" | "summary", "subject": str or null, "chapter": str or null,
  "topic": str or null, "count": int or null}}

- subject/chapter/topic: only when the student explicitly names one; copy the library name exactly.
  Otherwise null (the app then uses the scope the student selected).
- summary: they want an overview or revision sheet. count: number of flashcards/questions if they said one."""

def reply_lang(answer_lang, text, lang_code=None):
    """The student's "Reply in" choice, else the language they spoke or typed. Shared by every answer path."""
    return answer_lang or spoken_language(text, lang_code)


LANG_RULE = """Write the ENTIRE reply in {lang}, whatever language the question, notes or sources are in.
Use that language's own script (Tamil in Tamil script, Hindi in Devanagari, Bengali in Bengali script); if it
says Latin script, write it in Latin letters. Keep technical terms (Article numbers, Acts, case names) in
English where natural."""

def ensure_language(text, lang):
    """Models sometimes ignore the reply language (an English answer to "Reply in Tamil", Devanagari for Bengali).
    Check the script in code; if it's wrong, rewrite once. Costs a call only when needed."""
    if not text or in_language(text, lang):
        return text
    script = script_of(lang)
    target = f"{lang}, written in {script} script letters (not romanised)" if script else lang
    prompt = (f"Rewrite the text below in {target}. Keep the meaning, tone and every fact; change only the language "
              "and script. Keep Article numbers and case names in English. Output only the rewritten text.")
    for think in (False, True):  # the quick pass sometimes romanises; reasoning follows the script rule
        try:
            out = llm.chat(prompt, text, think=think).strip()
        except Exception:
            log.exception("language rewrite failed")
            continue
        if out and in_language(out, lang):
            return out
    return text  # a safety net must never break the answer


GENERATE = """You help an Indian student revise from their OWN notes (JSON in the user message).
Write directly about the subject; never refer to "the student", "your notes say" or who said what.
{lang_rule}
{task}
Return ONLY JSON."""

TASKS = {
    "ask": 'Answer the request using only the notes. If you add anything that is not in the notes, put it in a '
           'final separate paragraph that starts exactly with "Not from your notes:". Never mix it into the main '
           'answer. Shape: {{"answer": str}}',
    "summary": 'Write a compact revision sheet of the material, covering every topic in it: short headed sections '
               'with "- " bullet lines, plain text, no markdown symbols other than "- ". Shape: {{"answer": str}}',
    "flashcards": 'Make {n} flashcards, spread across all the topics present. '
                  'Shape: {{"cards": [{{"front": str, "back": str}}]}}',
    "quiz": 'Make {n} exam-style MCQs testing understanding, not trivia, spread across all the topics present. '
            'Shape: {{"questions": [{{"q": str, "options": [4 strings], "answer": 0-3, "explain": str}}]}}',
}

TOPIC_SUMMARY = """Condense these study notes on "{topic}" ({chapter}) into a compact revision summary in English.
Use "- " bullet lines. Keep every distinct fact, article, case, date and number; merge duplicates; add nothing
that is not in the notes. Neutral textbook voice. Return ONLY JSON: {{"summary": str}}"""


# ---------- note mode (background) ----------

def process_note(nid, audio=None):
    """Fill in a pending note: transcribe (voice only) -> structure -> embed + link -> ready.
    Each step updates the note's `stage`, which the UI polls. Any failure keeps the transcript for a retry."""
    doc, topic = db.raw(nid), None
    try:
        if audio:
            try:
                text, lang = asr.transcribe(audio)  # language detected per clip
            finally:
                os.unlink(audio)
            if not text.strip():
                return db.fail(nid, "Didn't catch any speech. Try again, a little closer to the mic.")
            db.update(nid, transcript=text, lang=lang, stage="structuring")
        else:
            text, lang = doc["transcript"], doc.get("lang")
            db.update(nid, stage="structuring")
        ch = db.chapter(str(doc["chapter_id"]))
        if not ch:
            return  # chapter deleted meanwhile; the note went with it
        r = llm.chat_json(
            NOTE.format(subject=ch["subject"], chapter=ch["name"], topics=json.dumps(ch["topics"], ensure_ascii=False)),
            json.dumps({"page_selection": (doc.get("source") or {}).get("selection") or None,
                        "detected_language": lang, "utterance": text}, ensure_ascii=False),
            think=True)  # background: quality over speed
        if not r.get("note"):
            return db.delete("note", nid)  # filler ("ok got it", "hmm"): nothing worth noting, drop it quietly
        db.update(nid, stage="linking")
        name = (r.get("topic") or "General").strip()
        topic = next((t for t in ch["topics"] if t.lower() == name.lower()), name)  # reuse existing spelling
        emb = llm.embed(note_text(r["note"]), "passage")
        db.finish(nid, topic, r["note"], emb, [(i, s) for i, s in db.similar(emb, k=5, exclude=nid) if s >= LINK_MIN])
    except Exception as e:
        log.exception("note %s failed", nid)
        return db.fail(nid, f"Couldn't process this note ({type(e).__name__}). Your words are saved; retry.")
    try:  # keep the topic's running summary fresh, so chapter summaries stay instant
        refresh_topic(str(doc["chapter_id"]), ch["name"], topic)
    except Exception:
        log.exception("topic summary refresh failed")


def refresh_topic(chapter_id, chapter_name, topic):
    ns = db.notes(chapter_id=chapter_id, topic=topic)
    if not ns:
        return None
    material = [{k: n[k] for k in ("title", "summary", "key_points")} for n in ns[-TOPIC_MAX:]]
    summary = llm.chat_json(TOPIC_SUMMARY.format(topic=topic, chapter=chapter_name),
                            json.dumps(material, ensure_ascii=False), think=True)["summary"]
    db.save_topic(chapter_id, topic, [n["id"] for n in ns], summary)
    return summary


# ---------- ask mode ----------

def ask(text, lang, ctx, intent=None):
    lib = db.tree()
    if intent:  # quick-action buttons
        r = {"intent": intent}
    elif lang is None:  # typed: keyword routing, no LLM round-trip
        r = route_typed(text, lib)
    else:  # voice: native-script transcript, let the LLM route it
        r = llm.chat_json(ASK.format(library=json.dumps(
            {s["name"]: {c["name"]: [t["name"] for t in c["topics"]] for c in s["chapters"]} for s in lib},
            ensure_ascii=False)), text)
    intent = r.get("intent") if r.get("intent") in TASKS else "ask"
    scope, label = _scope(lib, r, ctx)
    base = {"transcript": text, "lang": lang, "intent": intent, "scope": label, "coverage": None}

    if intent == "summary" and not scope.get("topic"):  # chapter/subject/all: from per-topic summaries
        tops = _topic_summaries(scope)
        material = [{k: t[k] for k in ("chapter", "topic", "summary")} for t in tops]
        if tops:
            base["coverage"] = f"all {len(tops)} topics · {sum(t['notes'] for t in tops)} notes"
    else:
        if intent == "ask" and not scope.get("chapter_id"):  # open question: semantic search
            notes = _search(text, subject_id=scope.get("subject_id"))
        else:
            pool = db.notes(**scope)
            if intent == "ask" and len(pool) > MAX_NOTES:  # big chapter: search inside it
                notes = _search(text, chapter_id=scope["chapter_id"])
            else:
                notes = spread(pool, MAX_NOTES)  # quiz/flashcards: balanced across topics
                if len(pool) > len(notes):
                    n_topics = len({(n["chapter_id"], n["topic"]) for n in pool})
                    base["coverage"] = f"{len(notes)} of {len(pool)} notes · all {n_topics} topics"
        material = [{k: n[k] for k in ("id", "chapter", "topic", "title", "summary", "key_points")} for n in notes]
    if not material:
        return {**base, "status": "empty", "answer": f"No notes in {label} yet."}
    out = llm.chat_json(
        GENERATE.format(lang_rule=LANG_RULE.format(lang=reply_lang(ctx.get("answer_lang"), text, lang)),
                        task=TASKS[intent].format(n=r.get("count") or 8)),
        f"Request: {text}\nNotes: {json.dumps(material, ensure_ascii=False)}\n"
        f"Reply language: {reply_lang(ctx.get('answer_lang'), text, lang)}")
    if out.get("answer"):
        out["answer"] = ensure_language(out["answer"], reply_lang(ctx.get("answer_lang"), text, lang))
    return {**base, "status": "ok", **out}


def _search(text, **filters):
    return db.notes(ids=[i for i, _ in db.similar(llm.embed(text, "query"), k=12, **filters)])


def _topic_summaries(scope):
    """Topic summaries in scope; stale or missing ones are rebuilt now, a few in parallel."""
    tops = db.topics(**scope)
    stale = [t for t in tops if t["summary"] is None]
    with ThreadPoolExecutor(4) as pool:
        for t, summary in zip(stale, pool.map(lambda t: refresh_topic(t["chapter_id"], t["chapter"], t["topic"]), stale)):
            t["summary"] = summary
    return [t for t in tops if t["summary"]]


def _scope(lib, r, ctx):
    """Scope named by the student wins; else the scope selected in the UI. Returns (db.notes kwargs, label)."""
    eq = lambda a, b: bool(a and b) and a.strip().lower() == b.strip().lower()
    pairs = [(s, c) for s in lib for c in s["chapters"]]
    named = [(s, c) for s, c in pairs
             if eq(c["name"], r.get("chapter")) and (not r.get("subject") or eq(s["name"], r["subject"]))]
    if named:
        s, c = named[0]
        topic = next((t["name"] for t in c["topics"] if eq(t["name"], r.get("topic"))), None)
        return ({"chapter_id": c["id"], "topic": topic} if topic else {"chapter_id": c["id"]},
                " › ".join(filter(None, (s["name"], c["name"], topic))))
    subj = next((s for s in lib if eq(s["name"], r.get("subject"))), None)
    if subj:
        return {"subject_id": subj["id"]}, subj["name"]
    cur = next(((s, c) for s, c in pairs if c["id"] == ctx.get("chapter_id")), None)
    if cur and ctx.get("scope") == "chapter":
        return {"chapter_id": cur[1]["id"]}, f"{cur[0]['name']} › {cur[1]['name']}"
    if cur and ctx.get("scope") == "subject":
        return {"subject_id": cur[0]["id"]}, cur[0]["name"]
    return {}, "all your notes"


def note_text(n):
    return "\n".join([n["title"], n["summary"], *n.get("key_points", [])])
