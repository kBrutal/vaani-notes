"""Run: cd backend && python -m tests.test_agents   (offline: the LLM client is faked, no DB calls)"""
import os

os.environ.setdefault("NVIDIA_API_KEY", "test")
os.environ.setdefault("MONGODB_URI", "mongodb://localhost:1")  # never contacted

from types import SimpleNamespace as NS  # noqa: E402

from app import agents, llm  # noqa: E402
from app.tools import Tool  # noqa: E402


def fake_client(replies, seen):
    def create(**kw):
        seen.append(kw)
        return NS(choices=[NS(message=replies.pop(0))])
    return NS(chat=NS(completions=NS(create=create)))


def tool_call(name, args):
    return NS(content="", tool_calls=[NS(id="c1", function=NS(name=name, arguments=args))])


def test_agent_loop():
    seen, calls = [], []
    llm.client = fake_client([tool_call("web_search", '{"query": "x"}'),
                              NS(content='{"reply": "done", "sources": ["https://a.in", "https://made-up.org"]}', tool_calls=None)], seen)
    search = Tool("web_search", "d", {"query": {"type": "string"}},
                  lambda query: calls.append(query) or [{"title": "A", "url": "https://a.in", "snippet": ""}])
    out, trace = agents.Agent(tools=[search]).run_json("q", system="s")
    assert calls == ["x"] and out["reply"] == "done" and trace[0]["tool"] == "web_search"
    assert seen[1]["messages"][-1]["role"] == "tool" and "https://a.in" in seen[1]["messages"][-1]["content"]  # result fed back
    assert agents._sources(out, trace) == [{"type": "web", "url": "https://a.in", "title": "A"}]  # invented URL dropped


def test_tool_errors_go_back_to_the_model():
    boom = Tool("t", "d", {}, lambda: 1 / 0)
    assert "ZeroDivisionError" in boom("{}")["error"]


def test_last_round_has_no_tools():
    seen = []
    agent = agents.Agent(tools=[Tool("t", "d", {}, lambda: [])])
    agent.max_steps = 1
    llm.client = fake_client([tool_call("t", "{}"), NS(content="final", tool_calls=None)], seen)
    assert agent.run("q", system="s")[0] == "final" and "tools" in seen[0] and "tools" not in seen[1]


def test_empty_answer_gets_one_nudge():
    seen = []
    llm.client = fake_client([NS(content="", tool_calls=None), NS(content="the answer", tool_calls=None)], seen)
    assert agents.Agent(tools=[Tool("t", "d", {}, lambda: [])]).run("q", system="s")[0] == "the answer"
    assert "tools" not in seen[1] and seen[1]["messages"][-1]["role"] == "user"


if __name__ == "__main__":
    test_empty_answer_gets_one_nudge()
    test_agent_loop()
    test_tool_errors_go_back_to_the_model()
    test_last_round_has_no_tools()
    print("ok")
