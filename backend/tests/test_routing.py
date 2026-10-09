"""Run: cd backend && python -m tests.test_routing   (offline: no models, no DB)"""
from app.routing import route_typed, spread

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


if __name__ == "__main__":
    test_route_typed()
    test_spread()
    print("ok")
