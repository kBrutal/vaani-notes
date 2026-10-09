"""Pure helpers (no models, no DB): keyword routing for typed questions, and topic-balanced sampling."""
import random
import re

STOP = {"of", "and", "the", "in", "to", "for", "a", "an", "on"}
INTENTS = [  # first match wins
    ("quiz", r"\bquiz|\bmcqs?\b|\btest me\b|\bpractice questions?\b"),
    ("flashcards", r"flash\s*-?\s*cards?"),
    ("summary", r"summar|\boverview\b|revision sheet|\bsaar\b|सारांश"),
]


def mentions(text, name):
    """Name appears in text, ignoring "(Art. 19-22)"-style suffixes; or as an acronym ("DPSP")."""
    t = text.lower()
    base = re.sub(r"\s*\(.*?\)", "", name).strip().lower()
    if base and re.search(rf"(?<!\w){re.escape(base)}(?!\w)", t):
        return True
    acronym = "".join(w[0] for w in re.findall(r"[a-z]+", base) if w not in STOP)
    return len(acronym) >= 2 and re.search(rf"\b{acronym}\b", t) is not None


def route_typed(text, lib):
    """Typed request -> same shape as the LLM router, without the LLM round-trip."""
    t = text.lower()
    intent = next((i for i, rx in INTENTS if re.search(rx, t)), "ask")
    count = re.search(r"\b(\d{1,2})\s*(?:flash\s*cards?|cards?|questions?|qs|mcqs?|sawal)", t)
    r = {"intent": intent, "subject": None, "chapter": None, "topic": None,
         "count": int(count.group(1)) if count else None}
    chapters = [(s, c) for s in lib for c in s["chapters"] if mentions(text, c["name"])]
    if chapters:
        s, c = max(chapters, key=lambda sc: len(sc[1]["name"]))  # most specific name wins
        r.update(subject=s["name"], chapter=c["name"],
                 topic=next((x["name"] for x in c["topics"] if mentions(text, x["name"])), None))
    else:
        r["subject"] = next((s["name"] for s in lib if mentions(text, s["name"])), None)
    return r


def spread(notes, n):
    """Up to n notes, round-robin across topics so every topic is represented; random within a topic."""
    if len(notes) <= n:
        return notes
    by_topic = {}
    for x in notes:
        by_topic.setdefault((x["chapter_id"], x["topic"]), []).append(x)
    for group in by_topic.values():
        random.shuffle(group)
    out, groups = [], list(by_topic.values())
    while len(out) < n:
        for g in groups:
            if g and len(out) < n:
                out.append(g.pop())
    return out
