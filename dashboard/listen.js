// Continuous listening: the mic stays on and speech is cut into segments at natural pauses (an energy-based
// voice activity detector against the room's own noise floor). Each segment is handed over as a 16 kHz mono WAV.
// Keep dashboard/listen.js and extension/listen.js identical.
const VAD = {
  startMs: 200,        // this much loud audio starts a segment
  endSilenceMs: 4000,  // a pause this long ends it: questions need time to think (3-5 s, per the student)
  keepTailMs: 300,     // trailing silence kept on a segment; the rest isn't uploaded or transcribed
  minSpeechMs: 500,    // shorter segments are coughs and clicks: dropped
  maxSegmentMs: 40000, // the ASR prefers <= 30-45 s per piece
  preRollMs: 400,      // keep the onset that came before the detector fired
  peekMs: 2500,        // onPeek gets the first this-many ms of a segment while it's still being spoken
};

class Listener {
  // getStream: another audio source (e.g. a captured browser tab) instead of the mic. playback: also play it
  // to the speakers (Chrome mutes a captured tab otherwise). vad: overrides for VAD. onSegment(wav, seconds).
  // onPeek(wav): the opening of a segment, early, e.g. to spot a wake phrase before the speaker has finished.
  constructor({ onSegment, onState = () => {}, onPeek = null, getStream = null, playback = false, vad = {} }) {
    Object.assign(this, { onSegment, onState, onPeek, getStream, playback });
    this.vad = { ...VAD, ...vad };
  }

  async start() {
    // Created before any await, while the click still counts as a user gesture (else Chrome starts it
    // suspended and no audio ever arrives); resume() covers the rest.
    this.ctx = new AudioContext();
    this.stream = this.getStream ? await this.getStream() : await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await this.ctx.resume();
    this.rate = this.ctx.sampleRate;
    // Keep references to every node: Chrome may garbage-collect an unreferenced source and capture silently stops.
    this.src = this.ctx.createMediaStreamSource(this.stream);
    // ponytail: ScriptProcessor is deprecated but works everywhere; move to an AudioWorklet if Chrome drops it
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e) => this.frame(new Float32Array(e.inputBuffer.getChannelData(0)));
    this.src.connect(this.proc);
    if (this.playback) this.src.connect(this.ctx.destination);
    this.proc.connect(this.ctx.destination);  // outputs silence; needed for onaudioprocess to fire
    this.paused = false;
    this.reset();
    this.onState('listening');
  }

  stop() {  // safe to call twice
    if (!this.ctx) return;
    this.proc?.disconnect();
    this.src?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx.close();
    this.ctx = this.proc = null;
    this.onState('off');
  }

  finish() {  // stop now, handing over whatever was being said (e.g. "send my question" clicked)
    const { seg, speechMs } = this;
    this.reset();
    this.stop();
    if (seg && speechMs >= this.vad.minSpeechMs) this.onSegment(toWav(seg, this.rate), (seg.length * seg[0].length) / this.rate);
    return !!(seg && speechMs >= this.vad.minSpeechMs);
  }

  pause() { this.paused = true; this.reset(); this.onState('paused'); }   // e.g. while Vaani answers a doubt
  resume() { if (this.proc) { this.paused = false; this.onState('listening'); } }

  reset() { this.pre = []; this.seg = null; this.loudMs = 0; this.silentMs = 0; this.speechMs = 0; this.peeked = false; }

  frame(x) {
    if (this.paused) return;
    const ms = (x.length / this.rate) * 1000;
    let sum = 0;
    for (const v of x) sum += v * v;
    const rms = Math.sqrt(sum / x.length);
    if (!this.seg) {  // room level: follows quiet quickly, creeps up slowly (speech onsets barely move it)
      this.noise = this.noise === undefined ? rms : rms < this.noise ? 0.7 * this.noise + 0.3 * rms : 0.995 * this.noise + 0.005 * rms;
    }
    const loud = rms > Math.max(0.01, this.noise * 3);

    if (!this.seg) {
      this.pre.push(x);
      while (this.pre.length * ms > this.vad.preRollMs) this.pre.shift();
      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.loudMs >= this.vad.startMs) {
        this.seg = [...this.pre];
        this.speechMs = this.loudMs;
        this.silentMs = 0;
        this.onState('hearing');
      }
      return;
    }
    this.seg.push(x);
    if (loud) { this.speechMs += ms; this.silentMs = 0; } else this.silentMs += ms;
    if (this.onPeek && !this.peeked && this.seg.length * ms >= this.vad.peekMs) {
      this.peeked = true;
      this.onPeek(toWav(this.seg, this.rate));
    }
    if (this.silentMs >= this.vad.endSilenceMs || this.seg.length * ms >= this.vad.maxSegmentMs) {
      const trim = Math.max(0, Math.floor((this.silentMs - this.vad.keepTailMs) / ms));
      const seg = this.seg.slice(0, this.seg.length - trim), { speechMs } = this;
      this.reset();
      this.onState('listening');
      if (speechMs >= this.vad.minSpeechMs) this.onSegment(toWav(seg, this.rate), (seg.length * ms) / 1000);
    }
  }
}

function toWav(frames, rate, outRate = 16000) {
  const n = frames.reduce((a, f) => a + f.length, 0);
  const pcm = new Float32Array(n);
  let o = 0;
  for (const f of frames) { pcm.set(f, o); o += f.length; }
  const ratio = rate / outRate;
  const len = Math.floor(n / ratio);
  const view = new DataView(new ArrayBuffer(44 + len * 2));
  const str = (off, s) => [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, outRate, true); view.setUint32(28, outRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {  // box-filter downsample: average the samples each output sample covers
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += pcm[j];
    const v = Math.max(-1, Math.min(1, s / (b - a)));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}
