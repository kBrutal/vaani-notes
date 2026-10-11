"""Pure helpers (no models, no DB): keyword routing for typed questions, and topic-balanced sampling."""
import random
import re

STOP = {"of", "and", "the", "in", "to", "for", "a", "an", "on"}
INTENTS = [  # first match wins
    ("quiz", r"\bquiz|\bmcqs?\b|\btest me\b|\bpractice questions?\b"),
    ("flashcards", r"flash\s*-?\s*cards?"),
    ("summary", r"summar|\boverview\b|revision sheet|\bsaar\b|सारांश"),
]


LANG_NAMES = {"hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu", "mr": "Marathi", "kn": "Kannada",
              "ml": "Malayalam", "gu": "Gujarati", "pa": "Punjabi", "or": "Odia", "as": "Assamese", "ur": "Urdu",
              "ne": "Nepali", "kok": "Konkani", "mai": "Maithili", "bho": "Bhojpuri", "sa": "Sanskrit"}
SCRIPTS = [("[\u0900-\u097F]", "Hindi"), ("[\u0980-\u09FF]", "Bengali"), ("[\u0A00-\u0A7F]", "Punjabi"),
           ("[\u0A80-\u0AFF]", "Gujarati"), ("[\u0B00-\u0B7F]", "Odia"), ("[\u0B80-\u0BFF]", "Tamil"),
           ("[\u0C00-\u0C7F]", "Telugu"), ("[\u0C80-\u0CFF]", "Kannada"), ("[\u0D00-\u0D7F]", "Malayalam"),
           ("[\u0600-\u06FF]", "Urdu")]
HINGLISH = re.compile(r"\b(hai|hain|kya|kaise|kyun|kyon|kaun|kab|nahi|nahin|matlab|samajh|batao|bata|mein|aur|"
                      r"ka|ki|ke|ko|toh|yeh|ye|wo|woh|bhi|tha|thi|karo|kar|hota|hoti|farak|fark)\b", re.I)


def spoken_language(text, lang_code=None):
    """The language the student used, decided in code so every answer path agrees (the LLM flip-flopped on
    Hinglish vs English). Voice: the ASR's language code; typed: the script, then Hinglish function words."""
    if lang_code in LANG_NAMES:
        return LANG_NAMES[lang_code]
    for rx, name in SCRIPTS:
        if re.search(rx, text):
            return name
    return "Hinglish (Hindi in Latin script mixed with English)" if HINGLISH.search(text) else "English"


SCRIPT_OF = {"Hindi": "\u0900-\u097F", "Marathi": "\u0900-\u097F", "Nepali": "\u0900-\u097F",
             "Konkani": "\u0900-\u097F", "Maithili": "\u0900-\u097F", "Bhojpuri": "\u0900-\u097F",
             "Sanskrit": "\u0900-\u097F", "Bengali": "\u0980-\u09FF", "Assamese": "\u0980-\u09FF",
             "Punjabi": "\u0A00-\u0A7F", "Gujarati": "\u0A80-\u0AFF", "Odia": "\u0B00-\u0B7F",
             "Tamil": "\u0B80-\u0BFF", "Telugu": "\u0C00-\u0C7F", "Kannada": "\u0C80-\u0CFF",
             "Malayalam": "\u0D00-\u0D7F", "Urdu": "\u0600-\u06FF"}
SCRIPT_NAME = {"\u0900-\u097F": "Devanagari", "\u0980-\u09FF": "Bengali", "\u0A00-\u0A7F": "Gurmukhi",
               "\u0A80-\u0AFF": "Gujarati", "\u0B00-\u0B7F": "Odia", "\u0B80-\u0BFF": "Tamil",
               "\u0C00-\u0C7F": "Telugu", "\u0C80-\u0CFF": "Kannada", "\u0D00-\u0D7F": "Malayalam",
               "\u0600-\u06FF": "Perso-Arabic (Urdu)"}
INDIC = "\u0900-\u0DFF\u0600-\u06FF"


def script_of(lang):
    """Name of the script lang is written in, e.g. "Tamil" -> "Tamil", "Marathi" -> "Devanagari"; else None."""
    rng = next((r for name, r in SCRIPT_OF.items() if lang.startswith(name)), None)
    return SCRIPT_NAME[rng] if rng else None


def in_language(text, lang):
    """Is text written in lang's script? Indic: mostly that script (English technical terms allowed).
    English: no Indic script. Hinglish: Latin letters with Hindi function words. Unknown languages pass."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return True
    rng = next((r for name, r in SCRIPT_OF.items() if lang.startswith(name)), None)
    if rng:
        return sum(bool(re.match(f"[{rng}]", c)) for c in letters) / len(letters) > 0.4
    if lang.startswith("Hinglish"):
        return not re.search(f"[{INDIC}]", text) and HINGLISH.search(text) is not None
    if lang.startswith("English"):
        return not re.search(f"[{INDIC}]", text)
    return True


# Wake phrase "Question Vaani": forces a question. The ASR writes it as "Question Vani" (English), "क्वेश्चन वाणी"
# (Hindi mode), "question bany" (Hindi voice, English mode)...
WAKE = re.compile(r"(?:^|(?<=[\s,.!?।]))(?:quest\w*|क्वे\S*)[\s,.-]+(?:[vwb]h?a+[nr]+[iyea]*|वा\S*|बा\S*)(?=\W|$)[\s,.!?-]*", re.I)


def split_wake(text):
    """Find the wake phrase anywhere: (True, said before it, said after it), else (False, text, "").
    Before it is still note; after it is the question."""
    m = WAKE.search(text or "")
    return (True, text[:m.start()].strip(" ,.-"), text[m.end():].strip()) if m else (False, text or "", "")


# indic-transcribe's own language ID: near-perfect for Bengali, Tamil, Telugu, Malayalam, Kannada... and for
# Hindi itself, but plain (Indian-accented) English lands in a Hindi-belt class with low confidence
# (measured: English -> gu 0.45, hi 0.68). So those guesses get a second look.
HINDI_BELT = {"hi", "gu", "ur", "mr", "mai", "bho", "bgc", "bhb", "hne", "doi", "ne", "sa", "kok", "pa"}  # pa: seen live


def needs_hindi_check(lang, prob):
    """True when the guess may be English in disguise: Hindi itself, or an unsure Hindi-belt guess."""
    return lang == "hi" or (lang in HINDI_BELT and prob < 0.9)


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
