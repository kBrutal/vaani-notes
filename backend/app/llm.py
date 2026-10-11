"""NVIDIA API Catalog (OpenAI-compatible) for chat + embeddings."""
import json
import os

import numpy as np
from openai import OpenAI

client = OpenAI(base_url="https://integrate.api.nvidia.com/v1", api_key=os.environ["NVIDIA_API_KEY"])
CHAT_MODEL = os.getenv("CHAT_MODEL", "nvidia/nemotron-3-super-120b-a12b")
EMBED_MODEL = os.getenv("EMBED_MODEL", "nvidia/nemotron-3-embed-1b")
# Nemotron can reason before answering: ~4x slower (4-7 s vs 1-2 s). Note-writing runs in the background and
# needs judgement (what's worth keeping), so it thinks; interactive answers don't, unless LLM_THINKING=on.
ASK_THINKING = os.getenv("LLM_THINKING", "off") == "on"


def chat(system, user, think=ASK_THINKING):
    r = client.chat.completions.create(
        model=CHAT_MODEL, temperature=0.2, max_tokens=8192,
        extra_body={"chat_template_kwargs": {"enable_thinking": think}},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
    return r.choices[0].message.content or ""


def chat_json(system, user, think=ASK_THINKING):
    return parse_json(chat(system, user, think))


def parse_json(s):
    # ponytail: models don't all honour response_format, so slice out the outermost JSON object
    return json.loads(s[s.find("{"): s.rfind("}") + 1])


def embed(text, kind):
    """kind: 'passage' when storing a note, 'query' when searching."""
    r = client.embeddings.create(model=EMBED_MODEL, input=[text], encoding_format="float",
                                 extra_body={"input_type": kind, "truncate": "END"})
    v = np.array(r.data[0].embedding, dtype=np.float32)
    return v / np.linalg.norm(v)
