"""MongoDB store: subjects > chapters (student-created) > notes (topic is a field the agent assigns).

Semantic search runs on MongoDB itself via Atlas Vector Search ($vectorSearch on notes.embedding), so there is
no separate vector DB. The vector index is created on first start.
"""
import logging
import os
import time
from datetime import datetime, timezone

from bson import ObjectId
from pymongo import MongoClient
from pymongo.collation import Collation
from pymongo.errors import ServerSelectionTimeoutError
from pymongo.operations import SearchIndexModel

URI = os.environ["MONGODB_URI"]  # Atlas: mongodb+srv://USER:PASS@CLUSTER.mongodb.net/?retryWrites=true&w=majority
DIMS = int(os.getenv("EMBED_DIMS", "2048"))  # nvidia/nemotron-3-embed-1b
VECTOR_INDEX = "note_vectors"
CI = Collation("en", strength=2)  # case-insensitive names: "polity" == "Polity"
# A note is saved the moment the student stops talking, then filled in by a background task. While that runs it
# carries `stage` (transcribing -> structuring -> linking, or failed + error); finished notes have no `stage`.
READY = {"stage": {"$exists": False}}
ACTIVE = ["transcribing", "structuring", "linking"]

mdb = MongoClient(URI, serverSelectionTimeoutMS=5000)[os.getenv("MONGODB_DB", "vaani")]  # fail fast, not after 30 s
subject_col, chapter_col, note_col, topic_col = mdb.subjects, mdb.chapters, mdb.notes, mdb.topics


def init():
    subject_col.create_index("name", unique=True, collation=CI)
    chapter_col.create_index([("subject_id", 1), ("name", 1)], unique=True, collation=CI)
    note_col.create_index([("chapter_id", 1), ("created_at", 1)])
    note_col.create_index("links.id")
    topic_col.create_index([("chapter_id", 1), ("name", 1)], unique=True)
    if not list(note_col.list_search_indexes(VECTOR_INDEX)):
        note_col.create_search_index(SearchIndexModel(name=VECTOR_INDEX, type="vectorSearch", definition={"fields": [
            {"type": "vector", "path": "embedding", "numDimensions": DIMS, "similarity": "dotProduct"},
            {"type": "filter", "path": "subject_id"},
            {"type": "filter", "path": "chapter_id"},
        ]}))
    note_col.update_many({"stage": {"$in": ACTIVE}}, {"$set": {"stage": "failed", "error": "Interrupted by a server restart."}})
    for _ in range(120):  # a new search index takes a few seconds to become queryable
        if all(i.get("queryable") for i in note_col.list_search_indexes(VECTOR_INDEX)):
            return
        time.sleep(1)
    raise RuntimeError(f"vector index {VECTOR_INDEX} never became queryable")


def init_when_reachable():
    """Server start: keep trying until Atlas is reachable (requests meanwhile get a clear 503), then init."""
    while True:
        try:
            return init()
        except ServerSelectionTimeoutError:
            logging.getLogger("vaani").warning("MongoDB Atlas unreachable (check Network Access / IP); retrying in 10 s")
            time.sleep(10)


def oid(s):
    return ObjectId(s) if ObjectId.is_valid(s or "") else None


def tree():
    """[{id, name, chapters: [{id, name, notes, topics: [{name, notes}]}]}], chapters in creation order."""
    topics = {}
    for r in note_col.aggregate([{"$match": READY}, {"$group": {"_id": {"c": "$chapter_id", "t": "$topic"}, "n": {"$sum": 1}}}]):
        topics.setdefault(r["_id"]["c"], []).append({"name": r["_id"]["t"], "notes": r["n"]})
    out = []
    for s in subject_col.find().sort("name", 1).collation(CI):
        chs = []
        for c in chapter_col.find({"subject_id": s["_id"]}).sort("_id", 1):
            ts = sorted(topics.get(c["_id"], []), key=lambda t: t["name"].lower())
            chs.append({"id": str(c["_id"]), "name": c["name"], "notes": sum(t["notes"] for t in ts), "topics": ts})
        out.append({"id": str(s["_id"]), "name": s["name"], "chapters": chs})
    return out


def add_subject(name):
    return str(subject_col.insert_one({"name": name.strip()}).inserted_id)


def add_chapter(subject_id, name):
    if not subject_col.find_one({"_id": oid(subject_id)}):
        raise LookupError("subject not found")
    return str(chapter_col.insert_one({"subject_id": oid(subject_id), "name": name.strip()}).inserted_id)


def _drop_notes(query):
    ids = note_col.distinct("_id", query)
    note_col.delete_many({"_id": {"$in": ids}})
    note_col.update_many({"links.id": {"$in": ids}}, {"$pull": {"links": {"id": {"$in": ids}}}})
    return len(ids)


def delete(kind, id_):
    _id = oid(id_)
    if kind == "note":
        return _drop_notes({"_id": _id})
    if kind == "chapter":
        _drop_notes({"chapter_id": _id})
        topic_col.delete_many({"chapter_id": _id})
        return chapter_col.delete_one({"_id": _id}).deleted_count
    _drop_notes({"subject_id": _id})
    topic_col.delete_many({"chapter_id": {"$in": chapter_col.distinct("_id", {"subject_id": _id})}})
    chapter_col.delete_many({"subject_id": _id})
    return subject_col.delete_one({"_id": _id}).deleted_count


def chapter(id_):
    c = chapter_col.find_one({"_id": oid(id_)})
    if not c:
        return None
    s = subject_col.find_one({"_id": c["subject_id"]})
    topics = sorted(note_col.distinct("topic", {"chapter_id": c["_id"], **READY}), key=str.lower)
    return {"id": str(c["_id"]), "name": c["name"], "subject_id": str(s["_id"]), "subject": s["name"], "topics": topics}


def add_pending(ch, source, stage, transcript=None, lang=None):
    """Store the note shell first, so a failure later never loses what the student said."""
    return str(note_col.insert_one({
        "subject_id": oid(ch["subject_id"]), "chapter_id": oid(ch["id"]), "source": source or {},
        "transcript": transcript, "lang": lang, "stage": stage, "links": [], "created_at": datetime.now(timezone.utc),
    }).inserted_id)


def raw(id_):
    return note_col.find_one({"_id": oid(id_)}, {"embedding": 0})


def update(id_, **fields):
    note_col.update_one({"_id": oid(id_)}, {"$set": fields, "$unset": {"error": ""}})


def fail(id_, error):
    note_col.update_one({"_id": oid(id_)}, {"$set": {"stage": "failed", "error": error}})


def finish(id_, topic, note, emb, links):
    """Fill in the note and mark it ready. links: [(note_id, cosine)], stored on both notes."""
    note_col.update_one({"_id": oid(id_)}, {"$set": {
        "topic": topic.strip(), "title": note["title"], "summary": note["summary"],
        "key_points": note.get("key_points", []), "flags": note.get("flags", []), "embedding": emb.tolist(),
        "links": [{"id": oid(i), "score": s} for i, s in links],
    }, "$unset": {"stage": "", "error": ""}})
    for i, s in links:
        note_col.update_one({"_id": oid(i), "links.id": {"$ne": oid(id_)}}, {"$push": {"links": {"id": oid(id_), "score": s}}})


def similar(emb, k=5, subject_id=None, chapter_id=None, exclude=None):
    """[(note_id, cosine)] best first, via Atlas Vector Search."""
    stage = {"index": VECTOR_INDEX, "path": "embedding", "queryVector": emb.tolist(),
             "numCandidates": max(100, k * 20), "limit": k + 1}
    if subject_id or chapter_id:
        stage["filter"] = {"chapter_id": oid(chapter_id)} if chapter_id else {"subject_id": oid(subject_id)}
    rows = note_col.aggregate([{"$vectorSearch": stage}, {"$project": {"score": {"$meta": "vectorSearchScore"}}}])
    # Atlas reports dotProduct as (1 + cosine) / 2; convert back so thresholds stay in cosine terms
    return [(str(r["_id"]), 2 * r["score"] - 1) for r in rows if str(r["_id"]) != exclude][:k]


def topics(chapter_id=None, subject_id=None):
    """Every topic in scope with its stored summary, or summary=None when missing or stale.
    A summary is stale when the topic's notes changed since it was written (tracked by note ids)."""
    q = dict(READY)
    if chapter_id:
        q["chapter_id"] = oid(chapter_id)
    if subject_id:
        q["subject_id"] = oid(subject_id)
    groups = list(note_col.aggregate([{"$match": q}, {"$sort": {"created_at": 1, "_id": 1}},
                                      {"$group": {"_id": {"c": "$chapter_id", "t": "$topic"}, "ids": {"$push": "$_id"}}}]))
    stored = {(d["chapter_id"], d["name"]): d for d in topic_col.find(
        {"chapter_id": {"$in": list({g["_id"]["c"] for g in groups})}})}
    names = {c["_id"]: c["name"] for c in chapter_col.find({"_id": {"$in": list({g["_id"]["c"] for g in groups})}})}
    out = []
    for g in groups:
        c, t = g["_id"]["c"], g["_id"]["t"]
        d = stored.get((c, t))
        out.append({"chapter_id": str(c), "chapter": names.get(c), "topic": t, "notes": len(g["ids"]),
                    "summary": d["summary"] if d and d["note_ids"] == g["ids"] else None})
    return sorted(out, key=lambda x: (x["chapter_id"], x["topic"].lower()))


def save_topic(chapter_id, topic, note_ids, summary):
    topic_col.update_one({"chapter_id": oid(chapter_id), "name": topic},
                         {"$set": {"note_ids": [oid(i) for i in note_ids], "summary": summary,
                                   "updated_at": datetime.now(timezone.utc)}}, upsert=True)


def notes(chapter_id=None, subject_id=None, topic=None, ids=None, include_pending=False):
    q = {} if include_pending else dict(READY)
    if chapter_id:
        q["chapter_id"] = oid(chapter_id)
    if subject_id:
        q["subject_id"] = oid(subject_id)
    if topic:
        q["topic"] = topic
    if ids is not None:
        q["_id"] = {"$in": [oid(i) for i in ids]}
    docs = list(note_col.find(q, {"embedding": 0}).sort([("created_at", 1), ("_id", 1)]))
    linked = {r["_id"]: r for r in note_col.find({"_id": {"$in": [l["id"] for d in docs for l in d["links"]]}, **READY},
                                              {"title": 1, "topic": 1, "chapter_id": 1})}
    names = {c["_id"]: c["name"] for c in chapter_col.find(
        {"_id": {"$in": list({d["chapter_id"] for d in docs} | {r["chapter_id"] for r in linked.values()})}})}
    subj = {s["_id"]: s["name"] for s in subject_col.find({"_id": {"$in": list({d["subject_id"] for d in docs})}})}
    return [{
        "id": str(d["_id"]), "stage": d.get("stage"), "error": d.get("error"),
        "title": d.get("title", ""), "summary": d.get("summary", ""), "key_points": d.get("key_points", []),
        "flags": d.get("flags", []), "transcript": d.get("transcript"), "lang": d.get("lang"), "source": d["source"],
        "topic": d.get("topic"), "chapter_id": str(d["chapter_id"]), "chapter": names.get(d["chapter_id"]),
        "subject_id": str(d["subject_id"]), "subject": subj.get(d["subject_id"]),
        "created_at": d["created_at"].isoformat() + "Z",
        "related": [{"id": str(r["_id"]), "title": r["title"], "topic": r["topic"],
                     "chapter_id": str(r["chapter_id"]), "chapter": names.get(r["chapter_id"])}
                    for l in sorted(d["links"], key=lambda l: -l["score"]) if (r := linked.get(l["id"]))],
    } for d in docs]

