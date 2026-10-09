"""Run against a throwaway database (never your real one):
    cd backend && MONGODB_URI=... MONGODB_DB=vaani_test EMBED_DIMS=3 python -m tests.test_db
"""
import os
import time

assert os.environ.get("MONGODB_DB", "").endswith("_test"), "set MONGODB_DB=<something>_test; this test drops it"
os.environ["EMBED_DIMS"] = "3"

import numpy as np  # noqa: E402
from pymongo.errors import DuplicateKeyError  # noqa: E402

from app import db  # noqa: E402


def v(*xs):
    a = np.array(xs, dtype=np.float32)
    return a / np.linalg.norm(a)


def wait_indexed(n):
    for _ in range(60):  # vector search is eventually consistent (~1 s)
        if len(db.similar(v(1, 1, 1), k=10)) >= n:
            return
        time.sleep(0.5)
    raise AssertionError("notes never showed up in vector search")


def test_store_link_query_delete():
    db.init()
    for col in (db.subject_col, db.chapter_col, db.note_col, db.topic_col):
        col.delete_many({})
    polity = db.add_subject("Polity")
    fr, dpsp = db.add_chapter(polity, "Fundamental Rights"), db.add_chapter(polity, "DPSP")
    try:
        db.add_chapter(polity, " fundamental rights")
        raise AssertionError("duplicate chapter allowed")
    except DuplicateKeyError:
        pass
    def add(ch, topic, title, emb, links=()):
        nid = db.add_pending(db.chapter(ch), {"type": "book"}, "structuring", transcript="...", lang="hi")
        db.finish(nid, topic, {"title": title, "summary": "s", "key_points": ["k"], "flags": []}, emb, list(links))
        return nid

    pending = db.add_pending(db.chapter(fr), None, "transcribing")
    assert db.notes(chapter_id=fr) == [] and db.notes(chapter_id=fr, include_pending=True)[0]["stage"] == "transcribing"
    db.fail(pending, "boom")
    assert db.raw(pending)["error"] == "boom" and db.tree()[0]["chapters"][0]["notes"] == 0  # not counted
    db.delete("note", pending)

    a = add(fr, "Right to Freedom", "Article 21", v(1, 0, 0))
    b = add(dpsp, "Gandhian Principles", "Article 47", v(0.9, 0.1, 0))
    wait_indexed(2)
    sims = db.similar(v(1, 0, 0), k=2, exclude=a)
    assert sims[0][0] == b and abs(sims[0][1] - float(v(1, 0, 0) @ v(0.9, 0.1, 0))) < 1e-3  # cosine, not Atlas score
    c = add(fr, "Right to Equality", "Article 14", v(0, 0, 1), links=[(a, 0.1)])
    wait_indexed(3)
    assert db.similar(v(0, 0, 1), k=1, chapter_id=dpsp)[0][0] == b  # chapter filter
    assert db.notes(ids=[a])[0]["related"][0]["id"] == c  # finish() links both ways
    db.delete("note", c)
    c = add(fr, "Right to Equality", "Article 14", v(0, 0, 1))
    db.finish(a, "Right to Freedom", {"title": "Article 21", "summary": "s", "key_points": ["k"], "flags": []},
              v(1, 0, 0), [(b, sims[0][1])])
    other = db.add_subject("History")
    assert db.similar(v(1, 0, 0), subject_id=other) == []

    lib = db.tree()
    assert [s["name"] for s in lib] == ["History", "Polity"]
    assert [ch["name"] for ch in lib[1]["chapters"]] == ["Fundamental Rights", "DPSP"]  # creation order
    assert lib[1]["chapters"][0]["notes"] == 2 and len(lib[1]["chapters"][0]["topics"]) == 2
    assert db.chapter(fr)["topics"] == ["Right to Equality", "Right to Freedom"]
    fr_notes = db.notes(chapter_id=fr)
    assert [n["title"] for n in fr_notes] == ["Article 21", "Article 14"]
    assert fr_notes[0]["related"] == [{"id": b, "title": "Article 47", "topic": "Gandhian Principles",
                                       "chapter_id": dpsp, "chapter": "DPSP"}]
    assert db.notes(chapter_id=fr, topic="Right to Equality")[0]["id"] == c

    tops = db.topics(chapter_id=fr)
    assert [(t["topic"], t["notes"], t["summary"]) for t in tops] == [("Right to Equality", 1, None), ("Right to Freedom", 1, None)]
    db.save_topic(fr, "Right to Freedom", [a], "- Article 21 ...")
    assert db.topics(chapter_id=fr)[1]["summary"] == "- Article 21 ..."
    d = add(fr, "Right to Freedom", "Article 19", v(1, 1, 0))
    assert db.topics(chapter_id=fr)[1]["summary"] is None  # new note -> stale
    db.delete("note", d)
    assert db.topics(chapter_id=fr)[1]["summary"] == "- Article 21 ..."  # back to the same notes -> fresh again

    assert db.delete("note", c) == 1
    assert db.chapter(fr)["topics"] == ["Right to Freedom"]  # topic vanishes with its last note
    assert db.delete("chapter", dpsp) == 1
    assert db.notes(ids=[b]) == [] and db.notes(ids=[a])[0]["related"] == []  # cascade: notes + links
    assert db.delete("subject", polity) == 1 and db.notes() == [] and db.delete("note", a) == 0
    assert db.topic_col.count_documents({}) == 0  # topic summaries removed with their chapters
    assert db.chapter("not-an-id") is None and db.delete("note", "not-an-id") == 0


if __name__ == "__main__":
    try:
        test_store_link_query_delete()
        print("ok")
    finally:
        db.mdb.client.drop_database(db.mdb.name)
