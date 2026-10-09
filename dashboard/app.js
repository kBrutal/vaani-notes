// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const api = async (path, opts = {}) => {
  const r = await fetch('/api' + path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${r.status})`);
  return body;
};
const send = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const store = {
  get: (k, d) => { try { return localStorage.getItem('vaani.' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('vaani.' + k, v); } catch {} },
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const ICONS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  cards: '<rect x="2" y="6" width="15" height="14" rx="2"/><path d="M7 2h13a2 2 0 0 1 2 2v12"/>',
  quiz: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}

// ---------- state ----------
const S = {
  lib: [],
  chapterId: store.get('chapter', '') || null,
  notes: [],
  topic: null,         // topic filter chip
  adding: null,        // subject id whose "add chapter" input is open
  ref: '',             // source field
  scope: store.get('scope', 'chapter'),
};
const current = () => {
  for (const s of S.lib) for (const c of s.chapters) if (c.id === S.chapterId) return { s, c };
  return null;
};
const ctx = () => ({
  chapter_id: S.chapterId,
  scope: S.scope,
  speak_lang: $('#speak').value || null,
  answer_lang: $('#lang').value || null,
  source: S.ref.trim() ? { type: 'book', ref: S.ref.trim() } : null,
});

async function refreshLib() {
  S.lib = await api('/tree');
  if (!current()) S.chapterId = null;
  renderLib();
}

// ---------- library (sidebar) ----------
function renderLib() {
  const el = $('#library');
  if (!S.lib.length) {
    el.innerHTML = '<p class="side-empty">No subjects yet. Add your first one below.</p>';
    return;
  }
  el.innerHTML = S.lib.map((s) => {
    const total = s.chapters.reduce((a, c) => a + c.notes, 0);
    const open = store.get('closed.' + s.id) !== '1' || S.adding === s.id;
    return `<details class="subj" data-sid="${s.id}" ${open ? 'open' : ''}>
      <summary>
        <span class="caret">${ic('chev')}</span>
        <span class="subj-name">${esc(s.name)}</span>
        <button class="icon-btn sm" data-act="add-chapter" data-sid="${s.id}" title="Add chapter">${ic('plus')}</button>
        <button class="icon-btn sm danger" data-act="del-subject" data-sid="${s.id}" title="Delete subject">${ic('trash')}</button>
        <span class="count">${total}</span>
      </summary>
      <ul>
        ${s.chapters.map((c) => `<li><button class="ch ${c.id === S.chapterId ? 'active' : ''}" data-act="open-chapter" data-cid="${c.id}">
          <span>${esc(c.name)}</span><span class="count">${c.notes}</span></button></li>`).join('')}
        <li>${S.adding === s.id
          ? `<form class="inline-add" data-form="new-chapter" data-sid="${s.id}"><input name="name" placeholder="Chapter name, then Enter" autocomplete="off" required aria-label="New chapter name"></form>`
          : `<button class="ch add" data-act="add-chapter" data-sid="${s.id}">${ic('plus')} Add chapter</button>`}</li>
      </ul>
    </details>`;
  }).join('');
  $('.inline-add input')?.focus();
}
$('#library').addEventListener('toggle', (e) => {
  if (e.target.matches('.subj')) store.set('closed.' + e.target.dataset.sid, e.target.open ? '0' : '1');
}, true);
$('#library').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.closest('.inline-add')) { S.adding = null; renderLib(); }
});
$('#library').addEventListener('focusout', (e) => {
  const f = e.target.closest('.inline-add');
  if (f && !e.target.value.trim()) setTimeout(() => { if (S.adding && !$('.inline-add input:focus')) { S.adding = null; renderLib(); } }, 150);
});

// ---------- main: chapter workspace ----------
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const safeUrl = (u) => (/^https?:\/\//.test(u || '') ? u : null);
function sourceHtml(src) {
  if (!src) return '';
  const url = safeUrl(src.url);
  if (url) {
    const t = src.t != null ? `${url.includes('?') ? '&' : '?'}t=${src.t}` : '';
    const at = src.t != null ? ` @ ${Math.floor(src.t / 60)}:${String(src.t % 60).padStart(2, '0')}` : '';
    return `<a href="${esc(url + t)}" target="_blank" rel="noopener">${ic(src.t != null ? 'video' : 'link')} ${esc(src.title || url)}${at}</a>`;
  }
  return src.ref ? `<span>${ic('book')} ${esc(src.ref)}</span>` : '';
}

const noteCard = (n) => `<article class="note" id="note-${n.id}">
  <header><h3>${esc(n.title)}</h3>
    <button class="icon-btn sm danger del" data-act="del-note" data-nid="${n.id}" title="Delete note">${ic('trash')}</button></header>
  <p class="sum">${esc(n.summary)}</p>
  ${n.key_points.length ? `<ul class="pts">${n.key_points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  ${n.flags.map((f) => `<div class="flag">${ic('alert')}<span>${esc(f)}</span></div>`).join('')}
  ${n.related.length ? `<div class="rel">${ic('link')}${n.related.map((r) => `<button class="rel-chip" data-act="goto-note" data-cid="${r.chapter_id}" data-nid="${r.id}" title="${esc(r.chapter)} › ${esc(r.topic)}">${esc(r.title)}</button>`).join('')}</div>` : ''}
  <footer>${sourceHtml(n.source)}<span class="when">${fmtDate(n.created_at)}${n.lang ? ' · ' + esc(n.lang.toUpperCase()) : ''}</span>
    ${n.transcript ? `<details class="tx"><summary>What you said</summary><p>${esc(n.transcript)}</p></details>` : ''}</footer>
</article>`;

// Notes are saved instantly and filled in by the server; these cards show each step until they're ready.
const STEPS = [['transcribing', 'Transcribing your voice'], ['structuring', 'Writing the note'], ['linking', 'Linking related notes']];
const pendingCard = (n) => n.stage === 'failed'
  ? `<article class="note failed" id="note-${n.id}">
      <span class="label">Couldn't save this note</span>
      <p class="err-msg">${esc(n.error)}</p>
      ${n.transcript ? `<details class="tx" open><summary>What you said</summary><p>${esc(n.transcript)}</p></details>` : ''}
      <div class="row">${n.transcript ? `<button class="btn sm primary" data-act="retry" data-nid="${n.id}">Retry</button>` : ''}
        <button class="btn sm" data-act="dismiss" data-nid="${n.id}">Dismiss</button></div>
    </article>`
  : `<article class="note skeleton" id="note-${n.id}">
      <ol class="live-steps">${STEPS.map(([k, label], i) => {
        const at = STEPS.findIndex(([x]) => x === n.stage);
        return `<li class="${i < at ? 'done' : i === at ? 'active' : ''}">${label}</li>`;
      }).join('')}</ol>
      ${n.transcript ? `<p class="tx-live">“${esc(n.transcript)}”</p>` : '<div class="bar" style="width:70%"></div><div class="bar"></div>'}
    </article>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watching = new Set();
async function watch(id) {  // poll one processing note until it's ready or failed
  if (watching.has(id)) return;
  watching.add(id);
  let stage;
  try {
    for (;;) {
      await sleep(700);
      const n = await api(`/notes/${id}`).catch(() => null);
      if (!n) return;  // deleted meanwhile
      if (!n.stage || n.stage === 'failed') {
        if (n.stage) toast("Couldn't save a note. Your words are kept, retry from the card.", 'error');
        else toast(`Saved “${n.title}” under ${n.topic}${n.related.length ? ` · linked to ${plural(n.related.length, 'note')}` : ''}`, 'ok');
        await refreshLib();
        if (S.chapterId === n.chapter_id) {
          S.notes = await api(`/chapters/${n.chapter_id}/notes`);
          renderMain();
          if (!n.stage) flash(n.id);
        }
        return;
      }
      if (n.stage !== stage) {
        stage = n.stage;
        S.notes = S.notes.map((x) => (x.id === id ? n : x));
        const card = $(`#note-${id}`);
        if (card) card.outerHTML = pendingCard(n);
      }
    }
  } finally {
    watching.delete(id);
  }
}

function welcome() {
  return `<div class="welcome">
    <button class="icon-btn menu-btn" data-act="toggle-side" title="Library">${ic('menu')}</button>
    <span class="logo">व</span>
    <h1>Your notes, in your own words.</h1>
    <p>Pick a chapter, press the mic and explain what you just understood, in Hindi, Tamil, Bengali or any mix with English.
       Vaani turns it into a structured note, files it under the right topic and links it to what you already know.</p>
    ${S.lib.length
      ? '<p class="muted">Choose a chapter from the library to begin.</p>'
      : `<form class="hero-form" data-form="first-setup">
          <input name="subject" placeholder="Subject, e.g. Polity" required autocomplete="off">
          <input name="chapter" placeholder="First chapter, e.g. Fundamental Rights" required autocomplete="off">
          <button class="btn primary lg">Create</button></form>`}
    <ol class="steps"><li><b>1</b>Pick a subject and chapter</li><li><b>2</b>Speak your understanding, topics are tagged for you</li><li><b>3</b>Ask, summarise, flashcards and quizzes</li></ol>
  </div>`;
}

function renderMain() {
  const m = $('#main');
  const cur = current();
  if (!cur) { m.innerHTML = welcome(); return; }
  const { s, c } = cur;
  const typing = $('#typebox') && !$('#typebox').hidden ? $('#typebox textarea').value : null;
  const ready = S.notes.filter((n) => !n.stage);
  const busy = S.notes.filter((n) => n.stage).reverse();
  const groups = new Map();
  for (const n of ready) groups.set(n.topic, [...(groups.get(n.topic) || []), n]);
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  if (S.topic && !groups.has(S.topic)) S.topic = null;
  const shown = S.topic ? [S.topic] : names;

  m.innerHTML = `
  <header class="ch-head">
    <div class="ch-title">
      <button class="icon-btn menu-btn" data-act="toggle-side" title="Library">${ic('menu')}</button>
      <div><div class="crumb">${esc(s.name)}</div><h1>${esc(c.name)}</h1>
        <div class="meta">${plural(ready.length, 'note')} · ${plural(names.length, 'topic')}</div></div>
      <button class="icon-btn danger" data-act="del-chapter" title="Delete chapter">${ic('trash')}</button>
    </div>
    <div class="ch-actions">
      <button class="btn primary lg" data-act="rec-note">${ic('mic')}<span class="rec-text">Add note by voice</span><kbd>Alt N</kbd></button>
      <button class="btn lg" data-act="type-note">${ic('pen')} Type a note</button>
      <label class="src">${ic('book')}<input id="ref" placeholder="Source: book, page, lecture…" value="${esc(S.ref)}" aria-label="Source"></label>
    </div>
    <form id="typebox" class="typebox" data-form="type-note" ${typing === null ? 'hidden' : ''}>
      <textarea name="text" placeholder="Explain the concept in your own words. Any language, mix English freely…" required>${esc(typing || '')}</textarea>
      <div class="row"><span class="muted">Saved to ${esc(c.name)}. The topic is picked automatically. ⌘/Ctrl + Enter to save.</span>
        <button type="button" class="btn ghost" data-act="cancel-type">Cancel</button><button class="btn primary">Save note</button></div>
    </form>
  </header>
  ${names.length > 1 ? `<nav class="chips" aria-label="Filter by topic">
    <button class="chip ${S.topic ? '' : 'active'}" data-act="topic" data-topic="">All <span class="count">${ready.length}</span></button>
    ${names.map((t) => `<button class="chip ${S.topic === t ? 'active' : ''}" data-act="topic" data-topic="${esc(t)}">${esc(t)} <span class="count">${groups.get(t).length}</span></button>`).join('')}
  </nav>` : ''}
  <div class="notes-area">
    ${busy.length ? `<section class="topic"><h2>Processing</h2><div class="masonry">${busy.map(pendingCard).join('')}</div></section>` : ''}
    ${ready.length
      ? shown.map((t) => `<section class="topic"><h2>${esc(t)} <span class="count">${groups.get(t).length}</span></h2>
          <div class="masonry">${groups.get(t).map(noteCard).join('')}</div></section>`).join('')
      : busy.length ? '' : `<div class="empty"><button class="empty-mic" data-act="rec-note" title="Add note by voice">${ic('mic')}</button>
          <h3>No notes in ${esc(c.name)} yet</h3>
          <p>Press the mic (or <b>Alt N</b>) and explain a concept you just read or watched. Topics inside the chapter are created automatically.</p></div>`}
  </div>`;
}

async function openChapter(cid, focusNote) {
  if (S.chapterId !== cid) S.topic = null;
  S.chapterId = cid;
  store.set('chapter', cid);
  renderLib();
  S.notes = await api(`/chapters/${cid}/notes`);
  renderMain();
  document.body.classList.remove('side-open');
  if (focusNote) flash(focusNote);
  S.notes.filter((n) => n.stage && n.stage !== 'failed').forEach((n) => watch(n.id));  // e.g. after a reload
}

function flash(nid) {
  const el = $(`#note-${nid}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

async function saveNote(promise) {
  try {
    const { id } = await promise;  // the note already exists (as "processing") on the server
    if (S.chapterId) { S.notes = await api(`/chapters/${S.chapterId}/notes`); renderMain(); }
    watch(id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- assistant ----------
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
function answerHtml(a, headings) {
  const [main, extra] = String(a || '').split(/Not from your notes:/i);
  return `<div class="prose">${prose(main, headings)}</div>${extra ? `<div class="outside"><span class="label">Not from your notes</span>${prose(extra)}</div>` : ''}`;
}
const deck = (cards) => `<div class="deck">
  ${cards.map((c, i) => `<div class="fc ${i ? '' : 'active'}" data-act="flip" role="button" tabindex="0" aria-label="Flashcard, press to flip">
    <div class="fc-inner"><div class="fc-face front">${esc(c.front)}<small>tap to flip</small></div><div class="fc-face back">${esc(c.back)}</div></div></div>`).join('')}
  <div class="deck-nav"><button class="icon-btn" data-act="deck" data-step="-1" title="Previous">${ic('left')}</button>
    <span class="deck-pos">1 / ${cards.length}</span><button class="icon-btn" data-act="deck" data-step="1" title="Next">${ic('chev')}</button></div></div>`;
const quiz = (qs) => `<div class="quiz"><div class="score">${qs.length} questions · pick an answer</div>
  ${qs.map((q, i) => `<div class="qq" data-answer="${q.answer}"><p>${i + 1}. ${esc(q.q)}</p>
    ${q.options.map((o, j) => `<button class="opt" data-act="opt" data-j="${j}">${'ABCD'[j]}. ${esc(o)}</button>`).join('')}
    <div class="explain" hidden>${esc(q.explain)}</div></div>`).join('')}</div>`;

function renderReply(r) {
  if (r.status === 'empty') return `<p class="muted">${esc(r.answer)}</p>`;
  const head = r.scope ? `<div class="scope-chip">${ic('book')} ${esc(r.scope)}${r.coverage ? ` · ${esc(r.coverage)}` : ''}</div>` : '';
  if (r.cards) return head + deck(r.cards);
  if (r.questions) return head + quiz(r.questions);
  return head + answerHtml(r.answer, r.intent === 'summary');
}

async function askFlow(label, promise) {
  $('.thread-hint')?.remove();
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="bubble">${esc(label)}</div><div class="reply pending"><span class="typing"><i></i><i></i><i></i></span></div>`;
  $('#thread').append(turn);
  const scroll = () => { $('#thread').scrollTop = $('#thread').scrollHeight; };
  scroll();
  const reply = $('.reply', turn);
  try {
    const r = await promise;
    if (r.transcript) $('.bubble', turn).textContent = r.transcript;
    reply.innerHTML = renderReply(r);
  } catch (e) {
    reply.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
  reply.classList.remove('pending');
  scroll();
}
const askText = (text, intent) => askFlow(text, api('/text', send('POST', { text, mode: 'ask', intent, ctx: ctx() })));

function renderScope() {
  document.querySelectorAll('.seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.scope === S.scope);
    b.setAttribute('aria-checked', b.dataset.scope === S.scope);
  });
}

// ---------- recording ----------
const R = { rec: null, mode: null, t0: 0, timer: null, cancelled: false };
async function toggleRec(mode) {
  if (R.rec) return R.mode === mode ? stopRec() : toast('Finish the current recording first.', 'warn');
  if (mode === 'note' && !current()) return toast('Pick or create a chapter first.', 'warn');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
    return toast('Microphone is blocked. Allow it from the address bar.', 'error');
  }
  const chunks = [];
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const { cancelled } = R;
    clearInterval(R.timer);
    Object.assign(R, { rec: null, mode: null });
    document.body.classList.remove('rec-note', 'rec-ask');
    $('#recpill').hidden = true;
    if (cancelled) return toast('Recording discarded.');
    const fd = new FormData();
    fd.append('audio', new Blob(chunks, { type: rec.mimeType }), rec.mimeType.includes('mp4') ? 'a.mp4' : 'a.webm');
    fd.append('mode', mode);
    fd.append('ctx', JSON.stringify(ctx()));
    const req = api('/voice', { method: 'POST', body: fd });
    if (mode === 'note') saveNote(req);
    else { openAssist(); askFlow('🎙 Transcribing your question…', req); }
  };
  Object.assign(R, { rec, mode, t0: Date.now(), cancelled: false });
  rec.start();
  $('#rec-label').textContent = mode === 'note' ? `Recording note → ${current().c.name}` : 'Recording question';
  $('#rec-stop').textContent = mode === 'note' ? 'Stop & save' : 'Stop & ask';
  $('#rec-time').textContent = '0:00';
  $('#recpill').hidden = false;
  document.body.classList.add(mode === 'note' ? 'rec-note' : 'rec-ask');
  R.timer = setInterval(() => {
    const s = Math.floor((Date.now() - R.t0) / 1000);
    $('#rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
}
function stopRec(cancel = false) { R.cancelled = cancel; R.rec?.stop(); }

const openAssist = () => { if (matchMedia('(max-width: 1180px)').matches) document.body.classList.add('assist-open'); };

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  try {
    switch (b.dataset.act) {
      case 'open-chapter': return await openChapter(b.dataset.cid);
      case 'add-chapter':
        e.preventDefault();
        S.adding = b.dataset.sid;
        return renderLib();
      case 'del-subject': {
        e.preventDefault();
        const s = S.lib.find((x) => x.id === b.dataset.sid);
        const n = s.chapters.reduce((a, c) => a + c.notes, 0);
        if (!confirm(`Delete subject “${s.name}” with ${plural(s.chapters.length, 'chapter')} and ${plural(n, 'note')}? This can't be undone.`)) return;
        await api(`/subjects/${s.id}`, { method: 'DELETE' });
        await refreshLib();
        renderMain();
        return toast(`Deleted ${s.name}.`);
      }
      case 'del-chapter': {
        const { c } = current();
        if (!confirm(`Delete chapter “${c.name}” and its ${plural(c.notes, 'note')}? This can't be undone.`)) return;
        await api(`/chapters/${c.id}`, { method: 'DELETE' });
        await refreshLib();
        renderMain();
        return toast(`Deleted ${c.name}.`);
      }
      case 'del-note': {
        if (!b.classList.contains('confirm')) {
          b.classList.add('confirm');
          b.textContent = 'Delete?';
          setTimeout(() => { if (b.isConnected) { b.classList.remove('confirm'); b.innerHTML = ic('trash'); } }, 3000);
          return;
        }
        const { nid } = b.dataset;
        $(`#note-${nid}`)?.classList.add('leaving');
        await api(`/notes/${nid}`, { method: 'DELETE' });
        S.notes = S.notes.filter((n) => n.id !== nid).map((n) => ({ ...n, related: n.related.filter((r) => r.id !== nid) }));
        setTimeout(renderMain, 200);
        await refreshLib();
        return toast('Note deleted.');
      }
      case 'retry': {
        const { nid } = b.dataset;
        await api(`/notes/${nid}/retry`, { method: 'POST' });
        S.notes = S.notes.map((n) => (n.id === nid ? { ...n, stage: 'structuring', error: null } : n));
        renderMain();
        return watch(nid);
      }
      case 'dismiss': {
        const { nid } = b.dataset;
        await api(`/notes/${nid}`, { method: 'DELETE' });
        S.notes = S.notes.filter((n) => n.id !== nid);
        return renderMain();
      }
      case 'goto-note': return await openChapter(b.dataset.cid, b.dataset.nid);
      case 'topic':
        S.topic = b.dataset.topic || null;
        renderMain();
        return $('#main').scrollTo({ top: 0 });
      case 'rec-note': return await toggleRec('note');
      case 'rec-ask': return await toggleRec('ask');
      case 'rec-stop': return stopRec();
      case 'rec-cancel': return stopRec(true);
      case 'type-note':
        $('#typebox').hidden = false;
        return $('#typebox textarea').focus();
      case 'cancel-type':
        $('#typebox').hidden = true;
        $('#typebox textarea').value = '';
        return;
      case 'scope':
        S.scope = b.dataset.scope;
        store.set('scope', S.scope);
        return renderScope();
      case 'quick': return await askText(b.textContent.trim(), b.dataset.intent);
      case 'example': return await askText(b.dataset.q);
      case 'flip': return b.classList.toggle('flipped');
      case 'deck': {
        const d = b.closest('.deck');
        const cards = [...d.querySelectorAll('.fc')];
        const i = cards.findIndex((c) => c.classList.contains('active'));
        const j = (i + Number(b.dataset.step) + cards.length) % cards.length;
        cards[i].classList.remove('active', 'flipped');
        cards[j].classList.add('active');
        $('.deck-pos', d).textContent = `${j + 1} / ${cards.length}`;
        return;
      }
      case 'opt': {
        const q = b.closest('.qq');
        if (q.classList.contains('done')) return;
        q.classList.add('done');
        const right = Number(q.dataset.answer);
        q.querySelectorAll('.opt')[right]?.classList.add('right');
        if (Number(b.dataset.j) !== right) b.classList.add('wrong');
        $('.explain', q).hidden = false;
        const qz = b.closest('.quiz');
        const done = [...qz.querySelectorAll('.qq.done')];
        const correct = done.filter((x) => !$('.opt.wrong', x)).length;
        const total = qz.querySelectorAll('.qq').length;
        $('.score', qz).textContent = done.length === total
          ? `Finished · ${correct} / ${total} correct`
          : `${correct} / ${done.length} correct · ${total - done.length} left`;
        return;
      }
      case 'toggle-side': return document.body.classList.toggle('side-open');
      case 'toggle-assist': return document.body.classList.toggle('assist-open');
      case 'close-drawers': return document.body.classList.remove('side-open', 'assist-open');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  e.preventDefault();
  try {
    if (f.id === 'add-subject') {
      const { id } = await api('/subjects', send('POST', { name: f.elements.name.value }));
      f.reset();
      S.adding = id;
      await refreshLib();
      return toast('Subject added. Now name its first chapter.', 'ok');
    }
    if (f.id === 'ask') {
      const text = $('#q').value.trim();
      if (!text) return;
      $('#q').value = '';
      $('#q').style.height = '';
      return await askText(text);
    }
    switch (f.dataset.form) {
      case 'new-chapter': {
        const { id } = await api(`/subjects/${f.dataset.sid}/chapters`, send('POST', { name: f.elements.name.value }));
        S.adding = null;
        await refreshLib();
        return await openChapter(id);
      }
      case 'first-setup': {
        const { id: sid } = await api('/subjects', send('POST', { name: f.elements.subject.value }));
        const { id } = await api(`/subjects/${sid}/chapters`, send('POST', { name: f.elements.chapter.value }));
        await refreshLib();
        return await openChapter(id);
      }
      case 'type-note': {
        const text = f.elements.text.value.trim();
        if (!text) return;
        f.hidden = true;
        f.elements.text.value = '';
        return await saveNote(api('/text', send('POST', { text, mode: 'note', ctx: ctx() })));
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'ref') S.ref = e.target.value;
  if (e.target.id === 'q') { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px'; }
});

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyN') { e.preventDefault(); toggleRec('note'); }
  else if (e.altKey && e.code === 'KeyA') { e.preventDefault(); openAssist(); toggleRec('ask'); }
  else if (e.key === 'Escape' && R.rec) stopRec(true);
  else if (e.key === 'Escape') document.body.classList.remove('side-open', 'assist-open');
  else if (e.target.id === 'q' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask').requestSubmit(); }
  else if (e.target.closest?.('#typebox') && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#typebox').requestSubmit(); }
  else if (e.target.matches?.('.fc') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.target.classList.toggle('flipped'); }
});

for (const k of ['speak', 'lang']) {
  $('#' + k).value = store.get(k, '');
  $('#' + k).addEventListener('change', () => store.set(k, $('#' + k).value));
}

// ---------- boot ----------
document.querySelectorAll('[data-ic]').forEach((el) => el.insertAdjacentHTML('afterbegin', ic(el.dataset.ic)));
renderScope();
refreshLib()
  .then(() => (S.chapterId ? openChapter(S.chapterId) : renderMain()))
  .catch((e) => { renderMain(); toast(`Can't reach the server: ${e.message}`, 'error'); });
