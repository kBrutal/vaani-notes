"""Agentic study session.

    StudySession  orchestrator: holds the live context of one study sitting (chapter, page, what was just
                  noted, the conversation) and the mode: "notetaking" or "conversation" (a doubt in progress)
    RouterAgent   decides what each utterance is: a note, a question / follow-up, the end of a doubt, or a
                  request for a study tool (summary, flashcards, quiz)
    TutorAgent    answers doubts with tools (search_notes, web_search), using the session context
    NoteTaker     hands notes to the background pipeline in agent.py (transcribe -> distil -> link)

Every agent is an Agent: a system prompt, optional tools, and a bounded LLM <-> tool loop.
"""
import json
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import agent, db, llm
from .agent import ASR_HINT, LANG_RULE, ensure_language, reply_lang
from .routing import route_typed, split_wake
from .tools import WEB_SEARCH, notes_tool

log = logging.getLogger("vaani")


class Agent:
    """System prompt + tools + a bounded tool-calling loop on the NVIDIA chat model."""
    system = ""
    max_steps = 4  # tool rounds before the model must answer

    def __init__(self, tools=(), think=llm.ASK_THINKING):
        self.tools = {t.name: t for t in tools}
        self.think = think

    def run(self, user, system=None):
        """Returns (final text, trace of tool calls)."""
        msgs = [{"role": "system", "content": system or self.system}, {"role": "user", "content": user}]
        trace, nudged = [], False
        for step in range(self.max_steps + 2):
            tools = [t.schema() for t in self.tools.values()] if step < self.max_steps and not nudged else None
            r = llm.client.chat.completions.create(
                model=llm.CHAT_MODEL, temperature=0.2, max_tokens=4096, messages=msgs,
                extra_body={"chat_template_kwargs": {"enable_thinking": self.think}},
                **({"tools": tools, "tool_choice": "auto"} if tools else {}))
            m = r.choices[0].message
            if not m.tool_calls:
                if (m.content or "").strip() or nudged:
                    return m.content or "", trace
                nudged = True  # an empty answer (seen after several searches): ask once more, without tools
                msgs.append({"role": "user", "content": "Now answer the student, using what you already have."})
                continue
            msgs.append({"role": "assistant", "content": m.content or "", "tool_calls": [
                {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                for c in m.tool_calls]})
            for c in m.tool_calls:
                tool = self.tools.get(c.function.name)
                result = tool(c.function.arguments) if tool else {"error": f"no tool named {c.function.name}"}
                trace.append({"tool": c.function.name, "args": json.loads(c.function.arguments or "{}"), "result": result})
                msgs.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(result, ensure_ascii=False)[:8000]})
        return "", trace  # unreachable: the last round has no tools, so the model must answer

    def run_json(self, user, system=None):
        text, trace = self.run(user, system)
        try:
            return llm.parse_json(text), trace
        except ValueError:
            return {"reply": text.strip()}, trace  # model answered in prose; keep it


class RouterAgent(Agent):
    system = ASR_HINT + """

You are the router of a voice study assistant. The microphone stays on while the student studies, so each
utterance is a stretch of speech between pauses. Mostly they dictate notes (explaining in their own words what
they read or understood); sometimes they ask a doubt, maybe follow-ups, then go back to dictating. One
utterance can contain both: a statement to note AND a question.

Split the LATEST utterance:
- note: the part they state or explain to remember, copied from the utterance in its original wording and
  language (not translated, not summarised); null if there is none. A question they answer themselves is note.
- question: if they ask something (a doubt, or a follow-up to the conversation), that question as a standalone
  English sentence, resolving "this / iska / that" from the session and page; null if none.
- question_spoken: that question part exactly as they said it; null if none.
- end: true only if they close a doubt without new content ("ok got it", "thanks", "samajh gaya", "back to
  notes").
- tool: "summary" | "flashcards" | "quiz" if they ask for that study tool ("quiz me on this chapter"), else null.
- ack: if end, a very short friendly line written in reply_language, in that language's own script (Hindi ->
  Devanagari, Tamil -> Tamil script; Latin letters only if it says so); else null.

Speech has NO punctuation, so judge by wording, not by "?": a part built around a question word (what, why,
how, when, which, who, kya, kaise, kyun, kaun, kab, "difference between", "explain") that asks for information
is a question, even transliterated into Devanagari ("व्हाट आर ..." = "what are ..."). Statements are notes,
even right after a question was answered.

Example: "western ghats ki wajah se west coast pe orographic rainfall hoti hai aur rain shadow kya hota hai" ->
{"note": "western ghats ki wajah se west coast pe orographic rainfall hoti hai", "question": "What is a rain
shadow?", "question_spoken": "rain shadow kya hota hai", "end": false, "tool": null, "ack": null}

Return ONLY JSON: {"note": str|null, "question": str|null, "question_spoken": str|null, "end": bool,
"tool": str|null, "ack": str|null}"""

    def route(self, text, session, allow_note=True, lang_code=None):
        r, _ = self.run_json(json.dumps({
            "mode": session.mode, "recent_session": session.recent(8), "page": session.page_brief(),
            "latest_utterance": text, "note_allowed": allow_note,
            "reply_language": reply_lang(session.ctx.get("answer_lang"), text, lang_code)}, ensure_ascii=False))
        parts = {"note": (r.get("note") or "").strip() or None, "question": (r.get("question") or "").strip() or None,
                 "question_spoken": r.get("question_spoken"), "end": bool(r.get("end")),
                 "tool": r.get("tool") if r.get("tool") in ("summary", "flashcards", "quiz") else None, "ack": r.get("ack")}
        if not any((parts["note"], parts["question"], parts["end"], parts["tool"])):
            parts["question" if not allow_note else "note"] = text  # unparseable: never drop what was said
        if not allow_note and parts["note"]:  # the ask box: everything is the question
            parts.update(note=None, question=parts["question"] or text)
        return parts


class TutorAgent(Agent):
    system = """You are Vaani, a study companion sitting next to an Indian student. They paused their
note-taking to ask a doubt. Answer like a good tutor talking to them (the reply may be read aloud):
- {lang_rule}
- 2-5 short sentences, conversational. No headings, tables or markdown; "- " bullet lines only when a list
  is genuinely clearer.
- Use the session context: what they are studying, the page and selected text, what they just noted, and the
  conversation so far (follow-ups refer back to it).
- Tools: search_notes for the student's own notes (when the doubt touches their material, or to connect the
  answer to what they noted); web_search only for specifics you are not certain of (exact dates, numbers,
  judgments, amendments, recent events), at most 2 searches. Standard textbook concepts (how the monsoon
  forms, what Article 21 says) need no search: answer directly.
- Be accurate. If their notes and the web disagree, say so briefly. Never invent sources.
Finish with ONLY a JSON object: {{"reply": str, "sources": [note ids or URLs you actually relied on]}}"""

    def answer(self, question, spoken, session, answer_lang, lang_code=None):
        lang = reply_lang(answer_lang, spoken, lang_code)
        system = self.system.format(lang_rule=LANG_RULE.format(lang=lang))
        out, trace = self.run_json(json.dumps({
            "studying": session.studying(), "page": session.page_brief(), "recent_session": session.recent(12),
            "question": question, "as_spoken": spoken}, ensure_ascii=False)
            + f"\n\nReply language: {lang}. Write the whole reply in it, whatever language the question is in.", system)
        reply = ensure_language(out.get("reply") or "Sorry, I couldn't work that out. Could you ask again?", lang)
        return reply, _sources(out, trace), trace


def _sources(out, trace):
    """Only sources the tools actually returned; the model may cite ids or URLs, never invented ones."""
    seen = {}
    for t in trace:
        for r in t["result"] if isinstance(t["result"], list) else []:
            if t["tool"] == "search_notes":
                seen[r["id"]] = {"type": "note", "id": r["id"], "title": r["title"], "chapter": r["chapter"],
                                 "chapter_id": r["chapter_id"]}
            elif t["tool"] == "web_search":
                seen[r["url"]] = {"type": "web", "url": r["url"], "title": r["title"]}
    cited = [seen[s] for s in out.get("sources") or [] if isinstance(s, str) and s in seen]
    return (cited or [s for s in seen.values() if s["type"] == "web"])[:4]


class NoteTaker:
    """Continuous listening sends many short stretches of speech. Note parts are collected into one draft and
    saved as one note (background pipeline: agent.process_note) when a question comes up, the draft gets long,
    the chapter changes, or the client says the student went quiet / stopped listening."""
    pool = ThreadPoolExecutor(2)
    MAX_WORDS = 250

    def __init__(self):
        self.parts, self.ctx, self.lang = [], None, None

    def add(self, text, lang, ctx):
        """Returns the id of a note saved because of this add (chapter changed / draft full), else None."""
        flushed = self.flush() if self.parts and self.ctx.get("chapter_id") != ctx.get("chapter_id") else None
        self.parts.append(text)
        self.ctx, self.lang = ctx, self.lang or lang
        if sum(len(p.split()) for p in self.parts) >= self.MAX_WORDS:
            flushed = self.flush()
        return flushed

    def draft(self):
        return " ".join(self.parts)

    def flush(self):
        """Save the draft as one note. Returns its id, or None (nothing drafted / no chapter)."""
        text, ctx, lang = self.draft().strip(), self.ctx or {}, self.lang
        self.parts, self.lang = [], None
        ch = db.chapter(ctx.get("chapter_id")) if text else None
        if not ch:
            return None
        nid = db.add_pending(ch, ctx.get("source"), "structuring", transcript=text, lang=lang)
        self.pool.submit(agent.process_note, nid)
        return nid


class StudySession:
    router = RouterAgent(think=False)
    answer_pool = ThreadPoolExecutor(4)

    def __init__(self, sid):
        self.id, self.mode, self.history, self.ctx = sid, "notetaking", [], {}
        self.lock, self.touched = threading.Lock(), time.time()
        self.notetaker, self.answers = NoteTaker(), {}
        self.awaiting_question = False  # "Question Vaani" was said on its own: the next stretch is the question

    # --- context the agents see ---
    def remember(self, role, kind, text):
        self.history = (self.history + [{"role": role, "kind": kind, "text": text[:600]}])[-24:]

    def recent(self, n):
        return self.history[-n:]

    def studying(self):
        ch = db.chapter(self.ctx.get("chapter_id"))
        return f"{ch['subject']} > {ch['name']}" if ch else None

    def page_brief(self):
        src = self.ctx.get("source") or {}
        return {k: v for k, v in {"title": src.get("title"), "url": src.get("url"), "video_time_s": src.get("t"),
                                  "selected_text": src.get("selection"), "book": src.get("ref")}.items() if v} or None

    # --- one stretch of speech in; notes and answers out, in parallel ---
    def turn(self, text, lang, ctx, expect="auto", woke=False):
        """expect: "auto" (main mic) or "question" (ask box / wake phrase: nothing is noted).
        Questions are answered in the background: the reply carries answer_id, fetched via answer()."""
        with self.lock:
            self.ctx, self.touched = ctx, time.time()
            if expect == "question" and lang is None:  # typed in the ask box: keywords, no router call
                r = route_typed(text, db.tree())
                parts = {"note": None, "question": text if r["intent"] == "ask" else None, "question_spoken": text,
                         "end": False, "tool": None if r["intent"] == "ask" else r["intent"], "ack": None}
            else:
                parts = self.router.route(text, self, allow_note=expect != "question" and not woke, lang_code=lang)
            if woke and not (parts["question"] or parts["tool"]):
                parts.update(question=text, question_spoken=text, end=False)  # "Question Vaani ...": always a question

            out = {"transcript": text, "lang": lang, "woke": woke, "note": parts["note"], "note_id": None}
            if parts["note"]:
                if not db.chapter(ctx.get("chapter_id")):
                    return {**out, "kind": "error", "reply": "Pick a chapter first, then I'll save your notes.",
                            "mode": self.mode}
                out["note_id"] = self.notetaker.add(parts["note"], lang, ctx)
                self.remember("student", "note", parts["note"])
                if not parts["question"]:
                    self.mode = "notetaking"
            out["drafting"] = self.notetaker.draft()  # a doubt doesn't close the note: it carries on afterwards

            if parts["tool"]:
                self.remember("student", parts["tool"], text)
                return {**out, **agent.ask(text, lang, ctx, intent=parts["tool"]), "kind": parts["tool"], "mode": self.mode}
            if parts["question"]:
                spoken = parts["question_spoken"] or text
                self.mode = "conversation"
                self.remember("student", "question", spoken)
                aid = uuid.uuid4().hex
                self.answers[aid] = {"status": "pending"}
                self.answer_pool.submit(self._answer, aid, parts["question"], spoken, dict(ctx), lang)
                return {**out, "kind": "question", "question": parts["question"], "question_spoken": spoken,
                        "answer_id": aid, "mode": self.mode}
            if parts["end"]:
                self.mode = "notetaking"
                self.remember("student", "end", text)
                ack = ensure_language(parts["ack"] or "Okay, back to your notes.", reply_lang(ctx.get("answer_lang"), text, lang))
                return {**out, "kind": "end", "reply": ack, "mode": self.mode}
            return {**out, "kind": "note", "mode": self.mode}

    def speech(self, text, lang, ctx):
        """Continuous listening. Everything is a note, unless the student says "Question Vaani": what follows is a
        question (what came before it is still note). Said on its own, the next stretch of speech is the question."""
        woke, before, after = split_wake(text)
        with self.lock:
            self.ctx, self.touched = ctx, time.time()
            if not woke and self.awaiting_question:
                woke, before, after = True, "", text
            self.awaiting_question = woke and not after
            note = before if woke else text
            out = {"transcript": text, "lang": lang, "woke": woke, "note": note or None, "note_id": None}
            if note:
                if not db.chapter(ctx.get("chapter_id")):
                    return {**out, "kind": "error", "reply": "Pick a chapter first, then I'll save your notes.", "mode": self.mode}
                out["note_id"] = self.notetaker.add(note, lang, ctx)
                self.remember("student", "note", note)
                if not woke:
                    self.mode = "notetaking"
            out["drafting"] = self.notetaker.draft()
            if not woke:
                return {**out, "kind": "note", "mode": self.mode}
            if not after:
                return {**out, "kind": "waiting", "mode": self.mode}
        r = self.turn(after, lang, ctx, "question", woke=True)
        return {**r, "transcript": text, "note": out["note"], "note_id": out["note_id"] or r.get("note_id")}

    def _answer(self, aid, question, spoken, ctx, lang):
        """Runs in the answer pool while note-taking carries on."""
        try:
            tutor = TutorAgent(tools=[notes_tool(ctx.get("chapter_id")), WEB_SEARCH])  # notes scoped to the chapter
            reply, sources, trace = tutor.answer(question, spoken, self, ctx.get("answer_lang"), lang)
            with self.lock:
                self.remember("tutor", "answer", reply)
            self.answers[aid] = {"status": "done", "kind": "question", "question": question, "transcript": spoken,
                                 "reply": reply, "sources": sources, "mode": self.mode,
                                 "steps": [{"tool": t["tool"], "query": t["args"].get("query")} for t in trace]}
        except Exception as e:
            log.exception("answer %s failed", aid)
            self.answers[aid] = {"status": "done", "kind": "error", "reply": f"Couldn't answer that ({type(e).__name__}). Ask again?"}

    def answer(self, aid):
        return self.answers.get(aid) or {"status": "missing"}

    def flush(self):
        """The student went quiet or stopped listening: save the note being drafted."""
        with self.lock:
            return self.notetaker.flush()

    def end(self):
        self.mode = "notetaking"
        self.remember("student", "end", "(back to notes)")


SESSIONS = {}
TTL = 3 * 3600  # ponytail: in-memory sessions, lost on restart; persist history in Mongo when follow-ups must survive it


def session(sid):
    now = time.time()
    for k in [k for k, s in SESSIONS.items() if now - s.touched > TTL]:
        del SESSIONS[k]
    return SESSIONS.setdefault(sid, StudySession(sid))
