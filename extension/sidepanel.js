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
const S = { api: 'http://localhost:8000', chapter: '', speak: '', lang: '', scope: 'chapter', tab: 'note', lib: [] };
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

$('#chapter').addEventListener('change', (e) => { save('chapter', e.target.value); notice(''); loadRecent(); });
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
async function toggleRec(mode) {
  if (R.rec) return R.mode === mode ? stopRec() : null;
  if (mode === 'note' && !S.chapter) return notice('Pick a chapter first (or create one with +).');
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
    if (cancelled) return;
    const fd = new FormData();
    fd.append('audio', new Blob(chunks, { type: rec.mimeType }), 'a.webm');
    fd.append('mode', mode);
    fd.append('ctx', JSON.stringify({ ...ctx(), speak_lang: S.speak || null, source }));
    const req = api('/voice', { method: 'POST', body: fd });
    if (mode === 'note') saveNote(req);
    else askFlow('🎙 Transcribing your question…', req);
  };
  Object.assign(R, { rec, mode, cancelled: false });
  rec.start();
  recUI(mode);
  const t0 = Date.now();
  R.timer = setInterval(() => {
    if (mode === 'note') $('#rec-status').textContent = `Listening… ${fmtT(Math.floor((Date.now() - t0) / 1000))} · tap to save`;
  }, 250);
}
function stopRec(cancel = false) { R.cancelled = cancel; R.rec?.stop(); }
function recUI(mode) {
  const note = mode === 'note';
  $('#mic').classList.toggle('recording', note);
  $('#mic').innerHTML = ic(note ? 'stop' : 'mic');
  $('#cancel-rec').hidden = !note;
  if (!note) $('#rec-status').textContent = 'Tap and explain what you understood';
  $('#ask-mic').classList.toggle('recording', mode === 'ask');
  $('#ask-mic').innerHTML = ic(mode === 'ask' ? 'stop' : 'mic');
}
$('#mic').addEventListener('click', () => toggleRec('note'));
$('#cancel-rec').addEventListener('click', () => stopRec(true));
$('#ask-mic').addEventListener('click', () => toggleRec('ask'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && R.rec) stopRec(true); });

// Alt+Shift+R from any page arrives here via the background worker
chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'toggle-recording') {
    chrome.storage.session.remove('autostart');
    showTab('note');
    toggleRec('note');
    reply(true);
  }
  if (msg.type === 'refresh') loadLib();
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
    $('#recent').innerHTML = notes.map(noteCard).join('') || '<div class="empty">No notes yet. Tap the mic and explain a concept.</div>';
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
function renderReply(r) {
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
const ctx = () => ({ chapter_id: S.chapter || null, scope: S.scope, answer_lang: S.lang || null });
const askText = (text, intent) => askFlow(text, post('/text', { text, mode: 'ask', intent, ctx: ctx() }));
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
$('#speak').addEventListener('change', (e) => save('speak', e.target.value));
$('#lang').addEventListener('change', (e) => save('lang', e.target.value));
chrome.storage.session.onChanged.addListener((ch) => {
  if (ch.notice?.newValue) { notice(ch.notice.newValue); chrome.storage.session.remove('notice'); }
});

(async () => {
  Object.assign(S, await chrome.storage.local.get(['api', 'chapter', 'speak', 'lang', 'scope', 'tab']));
  $('#api').value = S.api;
  $('#speak').value = S.speak;
  $('#lang').value = S.lang;
  $('#open-dash').href = S.api;
  renderScope();
  showTab(S.tab);
  recUI(null);
  const { notice: pending, autostart } = await chrome.storage.session.get(['notice', 'autostart']);
  if (pending) { notice(pending); chrome.storage.session.remove('notice'); }
  readPage();
  await loadLib();
  if (autostart && Date.now() - autostart < 5000) {  // the panel was opened by Alt+Shift+R
    chrome.storage.session.remove('autostart');
    showTab('note');
    toggleRec('note');
  }
})();
