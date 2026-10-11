"""Tools agents can call. A Tool is a plain function plus the JSON schema the LLM sees."""
import json
import logging

from . import db, llm

log = logging.getLogger("vaani")


class Tool:
    def __init__(self, name, description, parameters, fn, required=None):
        self.name, self.description, self.parameters, self.fn = name, description, parameters, fn
        self.required = list(parameters) if required is None else required

    def schema(self):
        return {"type": "function", "function": {
            "name": self.name, "description": self.description,
            "parameters": {"type": "object", "properties": self.parameters, "required": self.required}}}

    def __call__(self, arguments):
        """arguments: the JSON string the model produced. Errors go back to the model, not up the stack."""
        try:
            return self.fn(**json.loads(arguments or "{}"))
        except Exception as e:
            log.warning("tool %s failed: %s", self.name, e)
            return {"error": f"{type(e).__name__}: {e}"}


def web_search(query):
    from ddgs import DDGS  # ponytail: keyless DuckDuckGo; switch to Tavily/Brave/SearXNG if rate limits bite
    rows = DDGS(timeout=10).text(query, region="in-en", max_results=5)
    return [{"title": r["title"], "url": r["href"], "snippet": r["body"][:300]} for r in rows]


def notes_tool(chapter_id):
    """search_notes, scoped relative to the chapter the student is studying."""
    def search_notes(query, scope="chapter"):
        ch = db.chapter(chapter_id) if chapter_id else None
        filters = ({"chapter_id": ch["id"]} if scope == "chapter" else {"subject_id": ch["subject_id"]}) if ch and scope != "all" else {}
        ids = [i for i, _ in db.similar(llm.embed(query, "query"), k=6, **filters)]
        return [{"id": n["id"], "title": n["title"], "chapter": n["chapter"], "chapter_id": n["chapter_id"],
                 "topic": n["topic"], "key_points": n["key_points"]}
                for n in db.notes(ids=ids)]

    return Tool("search_notes", "Search the notes the student has already taken. Use it when the doubt touches "
                "their own material, or to connect the answer to what they noted earlier.",
                {"query": {"type": "string", "description": "what to look for"},
                 "scope": {"type": "string", "enum": ["chapter", "subject", "all"],
                           "description": "current chapter (default), its whole subject, or everything"}},
                search_notes, required=["query"])


WEB_SEARCH = Tool("web_search", "Search the web. Use it for facts you are not certain of: exact dates, numbers, "
                  "judgments, amendments, recent events. Don't search for things you know well.",
                  {"query": {"type": "string", "description": "a focused search query, in English"}}, web_search)
