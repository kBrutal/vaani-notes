// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ICONS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
document.querySelectorAll('[data-ic]').forEach((el) => el.insertAdjacentHTML('afterbegin', ic(el.dataset.ic)));

// ---------- settings (chrome.storage, shared with the background worker) ----------
const S = { api: 'http://localhost:8000', chapter: '', lang: '', scope: 'chapter', tab: 'note', lib: [], sid: '' };
const save = (k, v) => { S[k] = v; chrome.storage.local.set({ [k]: v }); };

async function api(path, opts = {}) {
  const r = await fetch(S.api + '/api' + path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${r.status})`);
  return body;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function notice(msg) {
  $('#notice').textContent = msg || '';
  $('#notice').hidden = !msg;
}

// ---------- library / chapter picker ----------
async function loadLib() {
  try {
    S.lib = await api('/tree');
    $('#conn').className = 'conn ok';
    $('#conn').title = `Connected to ${S.api}`;
  } catch (e) {  // a network error means no server; anything else is the server explaining what's wrong
    $('#conn').className = 'conn bad';
    $('#conn').title = `Can't reach ${S.api}`;
    $('#conn').dataset.wasDown = '1';
    notice(e instanceof TypeError ? `Can't reach the Vaani server at ${S.api}. Start it, or fix the URL in settings.` : e.message);
    return;
  }
  const chapters = S.lib.flatMap((s) => s.chapters);
  if (S.chapter && !chapters.some((c) => c.id === S.chapter)) save('chapter', '');
  $('#chapter').innerHTML = `<option value="">${chapters.length ? 'Pick a chapter…' : 'No chapters yet, create one →'}</option>` +
    S.lib.filter((s) => s.chapters.length).map((s) => `<optgroup label="${esc(s.name)}">${s.chapters.map((c) =>
      `<option value="${c.id}">${esc(c.name)} (${c.notes})</option>`).join('')}</optgroup>`).join('');
  $('#chapter').value = S.chapter;
  $('#nc-subject').innerHTML = S.lib.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') +
    '<option value="__new">＋ New subject…</option>';
  syncNewSubject();
  if ($('#conn').dataset.wasDown) notice('');
  delete $('#conn').dataset.wasDown;
  loadRecent();
}
const currentSubject = () => S.lib.find((s) => s.chapters.some((c) => c.id === S.chapter));

$('#chapter').addEventListener('change', (e) => {
  if (S.draft || S.lectureDraft) flushDraft('all');  // drafts belong to the chapter they were spoken in
  save('chapter', e.target.value);
  notice('');
  loadRecent();
});
$('#new-chapter-btn').addEventListener('click', () => {
  $('#new-chapter').hidden = !$('#new-chapter').hidden;
  if (!$('#new-chapter').hidden) {
    $('#nc-subject').value = currentSubject()?.id || (S.lib[0]?.id ?? '__new');
    syncNewSubject();
    $('#nc-name').focus();
  }
});
const syncNewSubject = () => { $('#nc-subject-name').hidden = $('#nc-subject').value !== '__new'; };
$('#nc-subject').addEventListener('change', syncNewSubject);
$('#nc-cancel').addEventListener('click', () => { $('#new-chapter').hidden = true; });
$('#new-chapter').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    let sid = $('#nc-subject').value;
    if (sid === '__new') {
      if (!$('#nc-subject-name').value.trim()) return $('#nc-subject-name').focus();
      sid = (await post('/subjects', { name: $('#nc-subject-name').value })).id;
    }
    const { id } = await post(`/subjects/${sid}/chapters`, { name: $('#nc-name').value });
    e.target.reset();
    e.target.hidden = true;
    save('chapter', id);
    notice('');
    await loadLib();
  } catch (err) {
    notice(err.message);
  }
});

// ---------- page context: what the student is looking at ----------
let page = null;
async function readPage({ pause = false, resume = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  let extra = {};
  try {
    [{ result: extra }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [pause, resume],
      func: (pause, resume) => {
        const v = [...document.querySelectorAll('video')].find((x) => x.currentTime > 0) || document.querySelector('video');
        const playing = !!v && !v.paused;
        if (v && pause) v.pause();
        if (v && resume) v.play();
        return { t: v ? Math.floor(v.currentTime) : null, playing, selection: getSelection().toString().trim().slice(0, 2000) };
      },
    });
  } catch {} // chrome:// pages, the PDF viewer, the web store: no scripting allowed
  page = { type: 'web', url: tab.url, title: tab.title, ...extra };
  renderContext();
  return page;
}
const fmtT = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
function renderContext() {
  if (!page) return;
  $('#context').innerHTML = `
    <div class="ctx-title">${ic(page.t != null ? 'video' : 'globe')}<span title="${esc(page.url)}">${esc(page.title || page.url)}</span>
      ${page.t != null ? `<span class="pill">@ ${fmtT(page.t)}</span>` : ''}</div>
    ${page.selection ? `<label class="sel"><input type="checkbox" id="attach" checked><q>${esc(page.selection)}</q></label>`
      : '<span class="muted">Select text on the page to attach it to your note.</span>'}`;
}
chrome.tabs.onActivated.addListener(() => { if (!R.rec) readPage(); });
chrome.tabs.onUpdated.addListener((_, info) => { if (!R.rec && (info.status === 'complete' || info.title)) readPage(); });
window.addEventListener('focus', () => { if (!R.rec) readPage(); });  // picks up a fresh selection
const pageSource = () => {
  if (!page) return null;
  const { playing, ...src } = page;
  if (!$('#attach')?.checked) delete src.selection;
  return src;
};

// ---------- recording ----------
const R = { rec: null, mode: null, timer: null, cancelled: false, resume: false };
async function toggleRec(mode) {  // the ask-tab mic: one question, press to start and stop
  if (R.rec) return R.mode === mode ? stopRec() : null;
  L.listener?.pause();  // continuous listening must not hear the same question
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
    notice('Microphone access is needed. Allow it in the tab that just opened, then try again.');
    return chrome.tabs.create({ url: 'permission.html' });
  }
  notice('');
  const p = await readPage({ pause: true });  // timestamp = where they started talking; the video waits for them
  R.resume = !!p?.playing;
  const source = pageSource();
  const chunks = [];
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(R.timer);
    const { cancelled, resume } = R;
    Object.assign(R, { rec: null, mode: null });
    recUI(null);
    if (resume) readPage({ resume: true });
    if (cancelled) return L.listener?.resume();
    const fd = new FormData();
    fd.append('audio', new Blob(chunks, { type: rec.mimeType }), 'a.webm');
    fd.append('expect', 'question');
    fd.append('ctx', JSON.stringify({ ...ctx(), source }));
    askFlow('🎙 Transcribing your question…', turn(api(`/session/${S.sid}/voice`, { method: 'POST', body: fd })).then(resolveAnswer))
      .finally(() => L.listener?.resume());
  };
  Object.assign(R, { rec, mode, cancelled: false });
  rec.start();
  recUI(mode);
  const t0 = Date.now();

}
function stopRec(cancel = false) { R.cancelled = cancel; R.rec?.stop(); }
function recUI(mode) {
  $('#ask-mic').classList.toggle('recording', mode === 'ask');
  $('#ask-mic').innerHTML = ic(mode === 'ask' ? 'stop' : 'mic');
}
$('#mic').addEventListener('click', () => toggleListening());
$('#ask-mic').addEventListener('click', () => toggleRec('ask'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && QV.listener) resumeAfterQuestion();  // cancel the question: nothing is sent
  else if (e.key === 'Escape' && R.rec) stopRec(true);
  else if (e.key === 'Escape' && L.listener) stopListening();
});

// Alt+Shift+R from any page arrives here via the background worker
chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'toggle-recording') {
    chrome.storage.session.remove('autostart');
    showTab('note');
    toggleListening();
    reply(true);
  }
  if (msg.type === 'refresh') loadLib();
  if (msg.type === 'capture-lecture') { chrome.storage.session.remove('lecture'); showTab('note'); toggleLecture(msg.lecture); }
});

// ---------- notes: saved instantly, processed by the server, shown with live steps ----------
const STEPS = [['transcribing', 'Transcribing'], ['structuring', 'Writing the note'], ['linking', 'Linking related notes']];
function noteCard(n) {
  if (n.stage === 'failed') {
    return `<div class="note failed" id="n-${n.id}"><span class="label">Couldn't save</span>${esc(n.error)}
      ${n.transcript ? `<p class="said">“${esc(n.transcript)}”</p>` : ''}
      <div class="row">${n.transcript ? `<button class="btn primary sm" data-retry="${n.id}">Retry</button>` : ''}
      <button class="btn sm" data-dismiss="${n.id}">Dismiss</button></div></div>`;
  }
  if (n.stage) {
    const at = STEPS.findIndex(([k]) => k === n.stage);
    return `<div class="note pending" id="n-${n.id}"><ol class="steps">${STEPS.map(([, label], i) =>
      `<li class="${i < at ? 'done' : i === at ? 'active' : ''}">${label}</li>`).join('')}</ol>
      ${n.transcript ? `<p class="said">“${esc(n.transcript)}”</p>` : ''}</div>`;
  }
  return `<div class="note" id="n-${n.id}"><span class="topic-chip">${esc(n.topic)}</span><h4>${esc(n.title)}</h4>
    <ul>${n.key_points.slice(0, 4).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    ${n.flags.map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}</div>`;
}
async function loadRecent() {
  if (!S.chapter) { $('#recent').innerHTML = '<div class="empty">Pick a chapter to see its notes here.</div>'; return; }
  try {
    const notes = (await api(`/chapters/${S.chapter}/notes`)).reverse().slice(0, 8);
    const draft = (S.draft ? `<div class="note pending"><span class="label">Drafting a note · saved after 45 s without notes, when it gets long, or when you stop</span>
      <p class="said">${esc(S.draft)}</p></div>` : '')
      + (S.lectureDraft ? `<div class="note pending"><span class="label">🎧 Drafting lecture notes · a note every few minutes of lecture</span>
      <p class="said">${esc(S.lectureDraft.slice(-400))}</p></div>` : '');
    $('#recent').innerHTML = draft + notes.map(noteCard).join('') || '<div class="empty">No notes yet. Tap the mic and explain a concept.</div>';
    notes.filter((n) => n.stage && n.stage !== 'failed').forEach((n) => watch(n.id));
  } catch (e) {
    $('#recent').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
const watching = new Set();
async function watch(id) {  // poll a processing note until it's ready or failed
  if (watching.has(id)) return;
  watching.add(id);
  try {
    for (;;) {
      await sleep(800);
      const n = await api(`/notes/${id}`).catch(() => null);
      const card = $(`#n-${id}`);
      if (!n) { card?.remove(); return; }
      if (card) card.outerHTML = noteCard(n);
      if (!n.stage || n.stage === 'failed') {
        if (!n.stage) { $(`#n-${id}`)?.classList.add('flash'); loadLib(); }
        return;
      }
    }
  } finally {
    watching.delete(id);
  }
}
async function saveNote(promise) {
  try {
    const { id } = await promise;
    await loadRecent();
    watch(id);
  } catch (e) {
    notice(e.message);
  }
}
$('#recent').addEventListener('click', async (e) => {
  const retry = e.target.closest('[data-retry]');
  const dismiss = e.target.closest('[data-dismiss]');
  try {
    if (retry) { await post(`/notes/${retry.dataset.retry}/retry`, {}); await loadRecent(); }
    if (dismiss) { await api(`/notes/${dismiss.dataset.dismiss}`, { method: 'DELETE' }); await loadRecent(); }
  } catch (err) { notice(err.message); }
});
$('#type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!S.chapter) return notice('Pick a chapter first (or create one with +).');
  const text = e.target.elements.text.value.trim();
  if (!text) return;
  e.target.reset();
  saveNote(post('/text', { text, mode: 'note', ctx: { chapter_id: S.chapter, source: pageSource() } }));
});

// ---------- study session: the agents decide note vs doubt, and keep the conversation's context ----------
function setMode(mode) { $('#convo').hidden = mode !== 'conversation'; }
async function turn(promise) {
  const r = await promise;
  if (r.mode) setMode(r.mode);
  return r;
}
async function resolveAnswer(r) {  // doubts are answered in the background; wait for this one
  if (!r.answer_id) return r;
  for (;;) {
    const a = await api(`/session/${S.sid}/answers/${r.answer_id}`);
    if (a.status !== 'pending') { if (a.mode) setMode(a.mode); return a; }
    await sleep(600);
  }
}

// ---------- continuous listening: one mic for notes and doubts ----------
const clock = { ms: 0, since: null };  // listening time; stands still while paused for an answer
const elapsed = () => {
  const s = Math.floor((clock.ms + (clock.since ? Date.now() - clock.since : 0)) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
function tick(state) {
  if (state === 'listening' || state === 'hearing') clock.since ??= Date.now();
  else if (clock.since) { clock.ms += Date.now() - clock.since; clock.since = null; }
  if (state === 'off') clock.ms = 0;
}
const L = { listener: null, queue: Promise.resolve(), idle: null, timer: null };
async function toggleListening() {
  if (L.listener) return stopListening();
  if (!S.chapter) return notice('Pick a chapter first (or create one with +).');
  const listener = new Listener({
    // in order, one at a time; while a doubt is being answered the queue waits, so nothing said is lost
    onSegment: (wav) => { L.queue = L.queue.then(() => sendSegment(wav)).catch((e) => console.error('segment', e)); },
    onPeek: checkWake,  // ~2.5 s into speaking: "Question Vaani"? then pause the lecture while they ask
    onState: listenUI,
  });
  try { await listener.start(); } catch {
    notice('Microphone access is needed. Allow it in the tab that just opened, then try again.');
    return chrome.tabs.create({ url: 'permission.html' });
  }
  notice('');
  L.listener = listener;
}
// "Question Vaani" spotted early (while the student is still talking): pause the video and the lecture capture
// at once, so only their voice is recorded for the rest of the question. Released when the answer is shown,
// or straight away if the full transcript turns out not to be a question.
const Q = { hold: false, resumeVideo: false };
async function checkWake(wav) {
  if (Q.hold) return;
  const fd = new FormData();
  fd.append('audio', wav, 'peek.wav');
  let r;
  try { r = await api('/wake', { method: 'POST', body: fd }); } catch { return; }
  if (!r.wake || Q.hold || !L.listener) return;
  Q.hold = true;
  const p = await readPage({ pause: true });
  Q.resumeVideo = !!p?.playing;
  LEC.listener?.pause();
  $('#rec-status').textContent = '“Question Vaani” heard · lecture paused, ask away';
}
function releaseHold() {
  if (!Q.hold) return;
  Q.hold = false;
  if (Q.resumeVideo) readPage({ resume: true });
  Q.resumeVideo = false;
  LEC.listener?.resume();
}

// ---------- the Question Vaani button: pause the video, take the question, answer, resume ----------
const QV = { listener: null, wasPlaying: false, busy: false };
async function questionVaani() {
  if (QV.busy) return;
  if (QV.listener) return QV.listener.finish() || resumeAfterQuestion();  // clicked again: send what was said
  const p = await readPage({ pause: true });  // the video stops at once
  QV.wasPlaying = !!p?.playing;
  LEC.listener?.pause();  // lecture capture and continuous listening hold, so only the question is heard
  L.listener?.pause();
  const listener = new Listener({
    vad: { endSilenceMs: 4000, maxSegmentMs: 60000 },
    onSegment: (wav) => { listener.stop(); askQuestion(wav); },
    onState: (s) => { if (s === 'hearing') qvUI('hearing'); },
  });
  try { await listener.start(); } catch {
    resumeAfterQuestion();
    notice('Microphone access is needed. Allow it in the tab that just opened, then try again.');
    return chrome.tabs.create({ url: 'permission.html' });
  }
  QV.listener = listener;
  qvUI('listening');
}
async function askQuestion(wav) {
  QV.listener = null;
  QV.busy = true;
  qvUI('sending');
  await readPage();
  const fd = new FormData();
  fd.append('audio', wav, 'question.wav');
  fd.append('expect', 'question');
  fd.append('ctx', JSON.stringify({ ...ctx(), source: pageSource() }));
  await askFlow('🎙 Transcribing your question…', turn(api(`/session/${S.sid}/voice`, { method: 'POST', body: fd })).then(resolveAnswer));
  resumeAfterQuestion();  // the answer is on screen: the lecture and listening pick up again
}
function resumeAfterQuestion() {
  QV.listener?.stop();
  Object.assign(QV, { listener: null, busy: false });
  if (QV.wasPlaying) readPage({ resume: true });
  QV.wasPlaying = false;
  LEC.listener?.resume();
  L.listener?.resume();
  qvUI('off');
}
function qvUI(state) {
  $('#qv-btn').classList.toggle('recording', state === 'listening' || state === 'hearing');
  $('#qv-btn').classList.toggle('sending', state === 'sending');
  $('#qv-btn').textContent = {
    listening: '🎙 Listening to your question… (click to send)',
    hearing: '🎙 Hearing you… (click to send, or pause 4 s)',
    sending: '⏳ Vaani is answering…',
  }[state] || '❓ Question Vaani';
}
$('#qv-btn').addEventListener('click', questionVaani);

async function stopListening() {
  const l = L.listener;
  L.listener = null;
  l?.stop();
  releaseHold();
  await L.queue;  // segments already said still reach the server; then close the note being drafted
  flushDraft('notes');
}
async function sendSegment(wav) {
  await readPage();  // the page as it is now: title, video time, selection
  const source = pageSource();
  const fd = new FormData();
  fd.append('audio', wav, 'a.wav');
  fd.append('expect', 'auto');
  fd.append('ctx', JSON.stringify({ ...ctx(), source }));
  let r;
  try { r = await turn(api(`/session/${S.sid}/voice`, { method: 'POST', body: fd })); } catch (e) { return notice(e.message); }
  if (r.note_id) watchNew(r.note_id);
  setDraft(r.drafting ?? S.draft);
  if (r.note) armIdleFlush();
  L.waiting = r.kind === 'waiting';  // "Question Vaani" said on its own: the next stretch is the question
  if (r.kind === 'waiting') return;  // keep the lecture paused: the question is coming
  if (r.kind !== 'question') releaseHold();  // the early "Question Vaani" check was a false alarm
  if (r.kind === 'error') return notice(r.reply);
  if (r.kind === 'empty' || r.kind === 'note' || r.kind === 'ignored') return;
  if (r.kind !== 'question') return askFlow(r.transcript || '…', Promise.resolve(r));  // quiz, summary
  clearTimeout(L.idle);  // note-taking (and the video) waits for the answer; speech meanwhile is held, not lost
  L.answering = true;
  const p = await readPage({ pause: true });
  await askFlow(r.question_spoken || r.transcript, resolveAnswer(r));
  if (p?.playing) readPage({ resume: true });
  releaseHold();  // the answer is shown: the lecture (video + capture) picks up again
  L.answering = false;
  if (S.draft) armIdleFlush();  // the same draft note carries on after the answer
}
// ---------- lecture capture: the tab's own audio becomes notes ----------
// The lecture playing in the tab is captured (and still played to you), cut at the lecturer's pauses, transcribed
// and drafted into notes of a few minutes each, linked to the video time. The mic meanwhile is for doubts only.
const LEC = { listener: null, queue: Promise.resolve(), tab: null };
async function toggleLecture(given) {  // given: a stream id minted by the Alt+Shift+L shortcut
  if (LEC.listener) return given ? null : stopLecture();
  if (!S.chapter) return notice('Pick a chapter first (or create one with +).');
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = given ? { id: given.tabId, url: given.url, title: given.title } : active;
  const listener = new Listener({
    getStream: async () => {
      const id = given?.streamId || await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      return navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } } });
    },
    playback: true,
    vad: { endSilenceMs: 1500 },  // lecturers pause between sentences; the draft stitches pieces into notes
    onSegment: (wav, secs) => { LEC.queue = LEC.queue.then(() => sendLecture(wav, secs)).catch((e) => console.error('lecture', e)); },
    onState: (s) => lectureUI(s),
  });
  try {
    await listener.start();
  } catch (e) {
    return notice(/invoked|activeTab/.test(e.message)
      ? 'Chrome needs you to call Vaani on the lecture tab first: on that tab press Alt+Shift+L (starts capture right away), or click the Vaani toolbar icon there and then this button.'
      : `Couldn't capture this tab's audio: ${e.message}`);
  }
  Object.assign(LEC, { listener, tab });
  if (!L.listener) {  // the mic comes on too, for "Question Vaani" doubts about the lecture
    await toggleListening();
    LEC.startedMic = !!L.listener;
  }
  notice('');
  lectureUI('listening');
}
async function stopLecture() {
  const l = LEC.listener;
  LEC.listener = null;
  l?.stop();
  lectureUI('off');
  if (LEC.startedMic && L.listener) stopListening();  // the mic came on with the lecture; it goes off with it
  LEC.startedMic = false;
  await LEC.queue;
  flushDraft('lecture');
}
async function sendLecture(wav, secs) {
  const p = await readPage();
  const source = { type: 'lecture', url: LEC.tab?.url || p?.url, title: LEC.tab?.title || p?.title,
                   t: p?.t != null ? Math.max(0, Math.round(p.t - secs)) : null };  // where this piece started
  const fd = new FormData();
  fd.append('audio', wav, 'lecture.wav');
  fd.append('ctx', JSON.stringify({ ...ctx(), source }));
  let r;
  try { r = await api(`/session/${S.sid}/lecture`, { method: 'POST', body: fd }); } catch (e) { return notice(e.message); }
  if (r.kind === 'error') return notice(r.reply);
  if (r.note_id) watchNew(r.note_id);
  if (r.kind === 'lecture') {
    S.lectureDraft = r.drafting;
    loadRecent();
    // No quick idle save for lectures (a lecturer can talk for 40 s straight): only when the draft is full,
    // capture stops, the chapter changes, or no lecture audio for 2 minutes (paused video).
    clearTimeout(LEC.idle);
    LEC.idle = setTimeout(() => flushDraft('lecture'), 120000);
  }
}
function lectureUI(state) {
  const on = !!LEC.listener || state === 'listening';
  $('#lecture-btn').classList.toggle('on', on && state !== 'off');
  $('#lecture-btn').textContent = on && state !== 'off' ? '⏹ Stop capturing lecture' : '🎧 Capture lecture audio';
  $('#lecture-status').hidden = state === 'off';
  $('#lecture-status').textContent = { listening: `Capturing the lecture · a note every few minutes${L.listener ? ' · mic on for “Question Vaani”' : ''}`,
    hearing: 'Hearing the lecture…', paused: 'Lecture paused' }[state] || '';
}
$('#lecture-btn').addEventListener('click', () => toggleLecture());

function armIdleFlush() { clearTimeout(L.idle); L.idle = setTimeout(flushDraft, 45000); }  // 45 s without notes: save
async function flushDraft(which = 'notes') {  // which draft: 'notes' (yours), 'lecture', or 'all'
  if (which !== 'lecture') clearTimeout(L.idle);
  if (which !== 'notes') clearTimeout(LEC.idle);
  try {
    const { note_ids = [] } = await api(`/session/${S.sid}/flush?which=${which}`, { method: 'POST' });
    if (which !== 'notes') S.lectureDraft = '';
    if (which !== 'lecture') setDraft(''); else loadRecent();
    note_ids.forEach(watchNew);
  } catch {}
}
async function watchNew(id) { await loadRecent(); watch(id); }
function setDraft(text) {
  if ((text || '') === (S.draft || '')) return;
  S.draft = text || '';
  loadRecent();
}
function listenUI(state) {
  tick(state);
  const on = state !== 'off';
  $('#mic').classList.toggle('recording', on && state !== 'paused');
  $('#mic').innerHTML = ic(on ? 'stop' : 'mic');
  const text = () => ({
    off: 'Tap to start listening',
    listening: L.answering ? `Vaani is answering · notes resume after it · ${elapsed()}`
      : L.waiting ? `Listening for your question… ${elapsed()}` : `Listening ${elapsed()} · notes, or “Question Vaani…”`,
    hearing: `Hearing you… ${elapsed()}`,
    paused: `Paused while Vaani answers · ${elapsed()}`,
  }[state]);
  $('#rec-status').textContent = text();
  clearInterval(L.timer);
  L.timer = on ? setInterval(() => { $('#rec-status').textContent = text(); }, 500) : null;
}
$('#end-convo').addEventListener('click', async () => {
  await api(`/session/${S.sid}/end`, { method: 'POST' }).catch(() => {});
  setMode('notetaking');
  askFlow('Back to notes', Promise.resolve({ kind: 'end', reply: 'Okay, back to your notes.' }));
  showTab('note');
});

// ---------- ask ----------
function prose(t, headings) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) out.push(`<ul>${list.join('')}</ul>`); list = []; };
  for (const line of String(t || '').split('\n')) {
    const l = line.trim();
    if (!l) { flush(); continue; }
    if (/^[-•*]\s+/.test(l)) { list.push(`<li>${esc(l.replace(/^[-•*]\s+/, ''))}</li>`); continue; }
    flush();
    out.push(headings && l.length < 70 && !/[.?!।]$/.test(l) ? `<h4>${esc(l.replace(/:$/, ''))}</h4>` : `<p>${esc(l)}</p>`);
  }
  flush();
  return out.join('');
}
const safeUrl = (u) => (/^https?:\/\//.test(u || '') ? u : '#');
function sourceChips(r) {
  const steps = r.steps?.length ? `<div class="steps-used">${r.steps.map((s) => `${s.tool === 'web_search' ? '🔎 Searched the web' : '📒 Searched your notes'}${s.query ? `: “${esc(s.query)}”` : ''}`).join('<br>')}</div>` : '';
  const chips = r.sources?.length ? `<div class="sources">${r.sources.map((s) => s.type === 'web'
    ? `<a class="src-chip" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">🌐 ${esc(s.title)}</a>`
    : `<a class="src-chip" href="${esc(S.api)}" target="_blank" title="${esc(s.chapter)}">📒 ${esc(s.title)}</a>`).join('')}</div>` : '';
  return steps + chips;
}
function renderReply(r) {
  if (r.kind === 'question') {
    const [main, extra] = String(r.reply || '').split(/Not from your notes:/i);
    return `<div class="tutor-tag">Vaani</div><div class="prose">${prose(main)}</div>${extra ? `<div class="outside">${prose(extra)}</div>` : ''}${sourceChips(r)}`;
  }
  if (r.kind === 'end') return `<p class="muted">↩ ${esc(r.reply)}</p>`;
  if (r.kind === 'empty' || r.kind === 'error') return `<p class="muted">${esc(r.reply)}</p>`;
  if (r.status === 'empty') return `<p class="muted">${esc(r.answer)}</p>`;
  const head = r.scope ? `<div class="scope-chip">${esc(r.scope)}${r.coverage ? ` · ${esc(r.coverage)}` : ''}</div>` : '';
  if (r.cards) {
    return head + `<div class="deck">${r.cards.map((c, i) => `<div class="fc ${i ? '' : 'active'}" tabindex="0" role="button" aria-label="Flashcard, press to flip">
      <div class="fc-inner"><div class="fc-face front">${esc(c.front)}</div><div class="fc-face back">${esc(c.back)}</div></div></div>`).join('')}
      <div class="deck-nav"><button class="icon-btn" data-step="-1" title="Previous">${ic('left')}</button><span class="pos">1 / ${r.cards.length} · tap to flip</span>
      <button class="icon-btn" data-step="1" title="Next">${ic('right')}</button></div></div>`;
  }
  if (r.questions) {
    return head + `<div class="quiz"><div class="score">${r.questions.length} questions</div>${r.questions.map((q, i) => `<div class="qq" data-answer="${q.answer}">
      <p>${i + 1}. ${esc(q.q)}</p>${q.options.map((o, j) => `<button class="opt" data-j="${j}">${'ABCD'[j]}. ${esc(o)}</button>`).join('')}
      <div class="explain" hidden>${esc(q.explain)}</div></div>`).join('')}</div>`;
  }
  const [main, extra] = String(r.answer || '').split(/Not from your notes:/i);
  return head + `<div class="prose">${prose(main, r.intent === 'summary')}</div>${extra ? `<div class="outside"><span class="label">Not from your notes</span>${prose(extra)}</div>` : ''}`;
}
async function askFlow(label, promise) {
  $('.hint-ask')?.remove();
  showTab('ask');
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="bubble">${esc(label)}</div><div class="reply"><span class="typing"><i></i><i></i><i></i></span></div>`;
  $('#thread').append(turn);
  $('#thread').scrollTop = $('#thread').scrollHeight;
  try {
    const r = await promise;
    if (r.transcript) $('.bubble', turn).textContent = r.transcript;
    $('.reply', turn).innerHTML = renderReply(r);
  } catch (e) {
    $('.reply', turn).innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
  $('#thread').scrollTop = $('#thread').scrollHeight;
}
const ctx = () => ({ chapter_id: S.chapter || null, scope: S.scope, answer_lang: S.lang || null, lecture_on: !!LEC.listener });
// quick buttons go straight to the study tools; everything else is a turn in the study session
const askText = (text, intent) => askFlow(text, intent
  ? post('/text', { text, mode: 'ask', intent, ctx: ctx() })
  : turn(post(`/session/${S.sid}/text`, { text, expect: 'question', ctx: { ...ctx(), source: pageSource() } })).then(resolveAnswer));
$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#q').value.trim();
  if (!text) return;
  $('#q').value = '';
  $('#q').style.height = '';
  askText(text);
});
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask-form').requestSubmit(); } });
$('#q').addEventListener('input', (e) => { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; });
document.querySelectorAll('.quick button').forEach((b) => b.addEventListener('click', () => askText(b.textContent.trim(), b.dataset.intent)));
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { save('scope', b.dataset.scope); renderScope(); }));
const renderScope = () => document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.scope === S.scope));
$('#thread').addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]');
  if (step) {
    const deck = step.closest('.deck');
    const cards = [...deck.querySelectorAll('.fc')];
    const i = cards.findIndex((c) => c.classList.contains('active'));
    const j = (i + Number(step.dataset.step) + cards.length) % cards.length;
    cards[i].classList.remove('active', 'flipped');
    cards[j].classList.add('active');
    $('.pos', deck).textContent = `${j + 1} / ${cards.length} · tap to flip`;
    return;
  }
  const fc = e.target.closest('.fc');
  if (fc) return fc.classList.toggle('flipped');
  const opt = e.target.closest('.opt');
  if (opt) {
    const q = opt.closest('.qq');
    if (q.classList.contains('done')) return;
    q.classList.add('done');
    const right = Number(q.dataset.answer);
    q.querySelectorAll('.opt')[right]?.classList.add('right');
    if (Number(opt.dataset.j) !== right) opt.classList.add('wrong');
    $('.explain', q).hidden = false;
    const quiz = opt.closest('.quiz');
    const done = [...quiz.querySelectorAll('.qq.done')];
    const total = quiz.querySelectorAll('.qq').length;
    $('.score', quiz).textContent = `${done.filter((x) => !$('.opt.wrong', x)).length} / ${done.length} correct${done.length < total ? ` · ${total - done.length} left` : ' · done'}`;
  }
});
$('#thread').addEventListener('keydown', (e) => {
  if (e.target.matches('.fc') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.target.classList.toggle('flipped'); }
});

// ---------- tabs, settings, boot ----------
function showTab(t) {
  S.tab = t;
  chrome.storage.local.set({ tab: t });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('#tab-note').hidden = t !== 'note';
  $('#tab-ask').hidden = t !== 'ask';
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#settings-btn').addEventListener('click', () => { $('#settings').hidden = !$('#settings').hidden; });
$('#api').addEventListener('change', (e) => {
  save('api', e.target.value.trim().replace(/\/+$/, '') || 'http://localhost:8000');
  $('#api').value = S.api;
  $('#open-dash').href = S.api;
  loadLib();
});
$('#lang').addEventListener('change', (e) => save('lang', e.target.value));
chrome.storage.session.onChanged.addListener((ch) => {
  if (ch.notice?.newValue) { notice(ch.notice.newValue); chrome.storage.session.remove('notice'); }
});

(async () => {
  Object.assign(S, await chrome.storage.local.get(['api', 'chapter', 'lang', 'scope', 'tab']));
  $('#api').value = S.api;
  $('#lang').value = S.lang;
  $('#open-dash').href = S.api;
  renderScope();
  showTab(S.tab);
  recUI(null);
  const { notice: pending, autostart, sid, lecture } = await chrome.storage.session.get(['notice', 'autostart', 'sid', 'lecture']);
  S.sid = sid || crypto.randomUUID();  // one study session per browser session; the agents keep its context
  if (!sid) chrome.storage.session.set({ sid: S.sid });
  if (pending) { notice(pending); chrome.storage.session.remove('notice'); }
  readPage();
  await loadLib();
  if (lecture && Date.now() - lecture.at < 8000) {  // the panel was opened by Alt+Shift+L
    chrome.storage.session.remove('lecture');
    showTab('note');
    toggleLecture(lecture);
  }
  if (autostart && Date.now() - autostart < 5000) {  // the panel was opened by Alt+Shift+R
    chrome.storage.session.remove('autostart');
    showTab('note');
    toggleListening();
  }
})();
