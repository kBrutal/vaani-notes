"""Speech -> text with bodhan-ai/indic-transcribe-core (Canary-1B-v2 fine-tune: 27 Indian languages,
handles code-mixing with English). The repo is gated: accept its terms on Hugging Face with the account
whose token is in HF_TOKEN.

One-time download (~4.9 GB) into backend/models/:  cd backend && python -m app.asr download
Check it standalone:                               cd backend && python -m app.asr clip.webm hi
"""
import functools
import os
import sys
import threading
from pathlib import Path

import av
import numpy as np
import torch
from huggingface_hub import snapshot_download

MODEL_ID = os.getenv("ASR_MODEL", "bodhan-ai/indic-transcribe-core")
MODEL_DIR = Path(os.getenv("ASR_MODEL_DIR", Path(__file__).resolve().parents[1] / "models" / MODEL_ID.split("/")[-1]))
# native | mixed | romanised. Per the model code these select the output script, but on our Hindi test clip all
# three returned the same Devanagari text, so English terms arrive transliterated and the LLM maps them back.
MODE = os.getenv("ASR_MODE", "native")
# cuda > mps (Apple GPU, ~9x faster than CPU on an M-series Mac) > cpu
DEVICE = os.getenv("ASR_DEVICE") or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
SR = 16000
_lock = threading.Lock()  # ponytail: one decode at a time; a request queue/batching if many users share a GPU
_load_lock = threading.Lock()  # warmup thread and first request must not load the model twice


def download():
    """Fetch once into MODEL_DIR (reads HF_TOKEN from env); later runs load from disk, no network."""
    done = MODEL_DIR / ".download_complete"
    if not done.exists():
        # skip the duplicate NeMo checkpoint (+4.9 GB); we use the transformers path. Resumes partials.
        snapshot_download(MODEL_ID, local_dir=MODEL_DIR, ignore_patterns=["nemo/*", "*.png"])
        done.touch()
    return str(MODEL_DIR)


def _load():
    with _load_lock:
        return _load_once()


@functools.cache
def _load_once():
    model_dir = download()
    sys.path.insert(0, model_dir)  # model code ships inside the repo
    import long_form
    from indic_transcribe import LANGUAGES, IndicTranscribe
    return IndicTranscribe.from_pretrained(model_dir, device=DEVICE), long_form, set(LANGUAGES)


def decode(path):
    """Any browser recording (webm/opus, mp4/aac, wav, ...) -> 16 kHz mono float32."""
    resampler = av.AudioResampler(format="flt", layout="mono", rate=SR)
    with av.open(path) as f:
        pcm = [r.to_ndarray().ravel() for frame in f.decode(audio=0) for r in resampler.resample(frame)]
    pcm += [r.to_ndarray().ravel() for r in resampler.resample(None)]  # flush
    return np.concatenate(pcm) if pcm else np.zeros(0, np.float32)


def transcribe(path, lang=None):
    """Returns (text, lang). Pass the student's language when known: the model's language-ID is weak
    for Hindi (0.26 top-1 per its docs) and confuses neighbours."""
    audio = decode(path)
    if len(audio) < 0.3 * SR:
        return "", lang
    model, long_form, langs = _load()
    lang = lang if lang in langs else None
    with _lock:
        lang = lang or long_form.identify_long(model, audio)
        # Any length: <=30 s decodes in one pass, longer is cut at pauses; also breaks decode loops.
        text = long_form.transcribe_long(model, audio, lang, mode=MODE)
    return text.strip(), lang


def warmup():
    """Load the model and run one tiny decode at server start: the first decode on MPS/CUDA is ~4x slower."""
    model, long_form, _ = _load()
    with _lock:
        long_form.transcribe_long(model, np.random.default_rng(0).normal(0, 1e-3, SR).astype(np.float32), "hi", mode=MODE)


if __name__ == "__main__":
    if sys.argv[1] == "download":
        print(download())
    else:
        print(transcribe(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
