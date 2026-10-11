"""Run: cd backend && python -m tests.test_routing   (offline: no models, no DB)"""
from app.routing import in_language, needs_hindi_check, route_typed, split_wake, spoken_language, spread

LIB = [{"name": "Polity", "chapters": [
    {"name": "Fundamental Rights", "topics": [{"name": "Right to Freedom (Articles 19-22)"}, {"name": "Right to Equality"}]},
    {"name": "Directive Principles of State Policy", "topics": [{"name": "Gandhian Principles"}]},
]}, {"name": "History", "chapters": []}]


def test_route_typed():
    r = route_typed("DPSP chapter ke 3 flashcards banao", LIB)
    assert (r["intent"], r["chapter"], r["count"]) == ("flashcards", "Directive Principles of State Policy", 3)
    r = route_typed("quiz me on right to freedom in fundamental rights, 5 questions", LIB)
    assert (r["intent"], r["chapter"], r["topic"], r["count"]) == ("quiz", "Fundamental Rights", "Right to Freedom (Articles 19-22)", 5)
    r = route_typed("Quiz me on Article 21", LIB)
    assert r["intent"] == "quiz" and r["count"] is None  # "21" is an article, not a count
    assert route_typed("Summarise this chapter", LIB)["intent"] == "summary"
    r = route_typed("Article 21 mein kya kya aata hai?", LIB)
    assert r == {"intent": "ask", "subject": None, "chapter": None, "topic": None, "count": None}
    assert route_typed("history overview", LIB)["subject"] == "History"


def test_spread():
    notes = [{"id": i, "chapter_id": "c", "topic": "big"} for i in range(50)] + [{"id": 99, "chapter_id": "c", "topic": "small"}]
    out = spread(notes, 10)
    assert len(out) == 10 and len({n["id"] for n in out}) == 10 and any(n["topic"] == "small" for n in out)
    assert spread(notes[:3], 10) == notes[:3]


def test_spoken_language():
    assert spoken_language("What is Article 21?") == "English"
    assert spoken_language("Article 21 kya hai?").startswith("Hinglish")
    assert spoken_language("procedure established by law aur due process mein farak?").startswith("Hinglish")
    assert spoken_language("अनुच्छेद 21 क्या है?") == "Hindi"
    assert spoken_language("அரசியலமைப்பு என்ன?") == "Tamil"
    assert spoken_language("अनुच्छेद 21 काय आहे?", "mr") == "Marathi"  # voice: the ASR's language code wins


def test_in_language():
    assert in_language("அரசியலமைப்பின் Article 21 உயிர் உரிமை", "Tamil")  # English terms allowed
    assert not in_language("Article 21 guarantees the right to life", "Tamil")
    assert not in_language("अनुच्छेद 21 जीवन का अधिकार", "Bengali")  # Devanagari is not Bengali script
    assert in_language("Article 21 life ka right deta hai", "Hinglish (Hindi in Latin script mixed with English)")
    assert not in_language("Article 21 guarantees the right to life.", "Hinglish (Hindi in Latin script mixed with English)")
    assert not in_language("अनुच्छेद 21", "English")


def test_split_wake():
    assert split_wake("Question Vani what are the mechanisms of the Indian monsoon") == (True, "", "what are the mechanisms of the Indian monsoon")
    assert split_wake("question, Vaani! why does it retreat") == (True, "", "why does it retreat")
    assert split_wake("क्वेश्चन वाणी मानसून कैसे बनता है") == (True, "", "मानसून कैसे बनता है")
    assert split_wake("question bany Mansoon Kesse Bantha He")[0]
    assert split_wake("western ghats cause heavy rain, question vaani what is a rain shadow") == (True, "western ghats cause heavy rain", "what is a rain shadow")
    assert split_wake("पश्चिमी घाट से बारिश होती है क्वेश्चन वाणी रेन शैडो क्या है") == (True, "पश्चिमी घाट से बारिश होती है", "रेन शैडो क्या है")
    assert split_wake("Question Vaani") == (True, "", "")  # the question comes in the next stretch of speech
    assert split_wake("question wane") == (True, "", "")  # live ASR spelling
    for not_wake in ["question vanilla", "question want", "question banner", "question when"]:
        assert split_wake(not_wake)[0] is False, not_wake
    assert split_wake("Questions about the monsoon are common in UPSC")[0] is False  # no "vaani"
    assert split_wake("The question of Vanilla")[0] is False
    assert split_wake("Request Vaani to explain")[0] is False  # "quest" must start a word
    assert split_wake("") == (False, "", "")


def test_needs_hindi_check():  # cases measured on indic-transcribe's language ID
    assert needs_hindi_check("gu", 0.45) and needs_hindi_check("hi", 0.68)  # English speech, misfiled
    assert needs_hindi_check("pa", 0.6)  # live: "OK so tell me about" came back in Gurmukhi
    assert needs_hindi_check("hi", 1.0)  # real Hindi still gets the (cheap) word check
    assert not needs_hindi_check("bn", 1.0) and not needs_hindi_check("ta", 0.6)  # strong classes: trust
    assert not needs_hindi_check("gu", 0.97) and not needs_hindi_check("en", 0.5)


if __name__ == "__main__":
    test_needs_hindi_check()
    test_split_wake()
    test_in_language()
    test_spoken_language()
    test_route_typed()
    test_spread()
    print("ok")
