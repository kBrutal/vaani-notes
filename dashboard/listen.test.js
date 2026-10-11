// Run: node dashboard/listen.test.js   (offline: feeds synthetic audio frames to the voice activity detector)
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const sandbox = { Blob, Math, Float32Array, DataView, ArrayBuffer };
vm.createContext(sandbox);
vm.runInContext(`${fs.readFileSync(`${__dirname}/listen.js`, 'utf8')}; this.Listener = Listener;`, sandbox);

const RATE = 48000, FRAME = 4096;
const frame = (amp) => Float32Array.from({ length: FRAME }, (_, i) => amp * Math.sin(i / 7) + (Math.random() - 0.5) * 0.002);
const frames = (ms, amp) => Array.from({ length: Math.round((ms / 1000) * RATE / FRAME) }, () => frame(amp));

(async () => {
  const segments = [], states = [];
  const l = new sandbox.Listener({ onSegment: (b) => segments.push(b), onState: (s) => states.push(s) });
  Object.assign(l, { rate: RATE, paused: false, proc: {} });  // as if start() ran
  l.reset();
  const feed = (fs_) => fs_.forEach((f) => l.frame(f));

  feed(frames(1000, 0));      // quiet room: learns the noise floor
  feed(frames(2000, 0.3));    // speech
  feed(frames(4300, 0));      // pause -> segment 1
  feed(frames(100, 0.3));     // a click: too short to start a segment
  feed(frames(4300, 0));
  feed(frames(1500, 0.3));    // speech...
  l.pause();                  // ...Vaani starts answering: dropped, nothing sent
  feed(frames(2000, 0.3));
  l.resume();
  feed(frames(1500, 0.3));    // speech after the answer
  feed(frames(3000, 0));      // a 3 s pause to think: not the end
  feed(frames(800, 0.3));
  feed(frames(4300, 0));      // -> segment 2 (one segment, not two)

  assert.strictEqual(segments.length, 2, `expected 2 segments, got ${segments.length}`);
  const header = Buffer.from(await segments[0].arrayBuffer());
  assert.strictEqual(header.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(header.readUInt32LE(24), 16000);  // 16 kHz out
  const secs = (header.length - 44) / 2 / 16000;
  assert.ok(secs > 2 && secs < 3, `segment 1 should be ~2 s of speech + pre-roll + a short tail (trailing silence trimmed), got ${secs.toFixed(2)} s`);
  assert.deepStrictEqual([...new Set(states)], ['hearing', 'listening', 'paused']);
  console.log('ok');
})();
