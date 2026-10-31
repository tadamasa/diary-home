import * as db from './db.js';
import * as sync from './sync.js';
import * as gemini from './gemini.js';
import { exportData, importData } from './backup.js';
import { moodOf, moodStyle, skyOf, SKY_LABEL, moonAge, moonName, moonPath, affectOf, setCustomAffect, clampAffect, hueOf, sortTags } from './mood.js';
import { esc, today, nowTime, isDate, dateLabel, monthCells, shiftMonth, splitTags, entriesOn, tagChoices, buildPrompt, renderAnswer, makeEntry } from './diary.js';

// ---------- 状態 ----------
const state = {
  entries: [],
  tags: { feelings: [], thinkings: [] },
  prompts: {},
  cal: null, // [年, 月] 日記タブで表示中の月
  side: {}, // 日付ごとの縁泉・読了本(開いている間だけ覚える)
};
const form = { id: null, datetime: '', text: '', feelings: new Set(), thinkings: new Set() };

const $view = document.getElementById('view');

function toast(msg, ms = 2600) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

function setTitle(text, { back = false, sub = '' } = {}) {
  document.getElementById('nav-title').textContent = text;
  document.getElementById('nav-title-large').textContent = text;
  document.getElementById('nav-sub').innerHTML = sub;
  document.getElementById('back').hidden = !back;
  document.title = `${text} - 日記`;
}

function setTab(tab) {
  for (const a of document.querySelectorAll('.tabbar__item')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

async function load() {
  const [entries, tags, prompts, affect] = await Promise.all([db.getAll('entries'), db.getMeta('tags'), db.getMeta('prompts'), db.getMeta('affect')]);
  setCustomAffect(affect);
  state.affect = affect || {};
  state.tagOrder = (await db.getMeta('tagOrder')) || 'color';
  state.entries = entries;
  state.tags = tags || { feelings: [], thinkings: [] };
  state.prompts = prompts || {};
}

function syncLine(st) {
  if (st.state === 'off') return 'この端末だけに保存されます(設定で日記ハブにつなぐとスプレッドシートと同期します)';
  if (st.state === 'syncing') return '同期しています…';
  if (st.state === 'error') return `同期できませんでした: ${st.error}${st.pending ? `(未送信 ${st.pending}件はこの端末に残っています)` : ''}`;
  const at = st.lastAt ? new Date(st.lastAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだ';
  return `最後の同期: ${at}${st.pending ? ` ・ 未送信 ${st.pending}件` : ''}`;
}

let unwatch = null;
function watchSync(el) {
  if (unwatch) unwatch();
  if (!el) { unwatch = null; return; }
  const show = st => { if (document.body.contains(el)) el.textContent = syncLine(st); };
  unwatch = sync.onStatus(show);
  show(sync.status);
}

// ---------- 空と月 ----------
function moonSvg(date, size = 16) {
  const age = moonAge(date);
  return `<svg class="moon" width="${size}" height="${size}" viewBox="-11 -11 22 22" aria-hidden="true"><circle r="10" class="moon__dark"/><path d="${moonPath(age, 10)}" class="moon__lit"/></svg>`;
}

function daySub(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const at = new Date(y, m - 1, d, 21);
  return `${moonSvg(at)}<span>${dateLabel(dateStr).replace(/^\d+年/, '')} ・ ${moonName(moonAge(at))}</span>`;
}

function applySky() {
  document.documentElement.dataset.sky = skyOf();
}

// こころの色の小さな玉
function orb(feelings, cls = '') {
  const m = moodOf(feelings);
  return `<span class="orb${m ? '' : ' orb--none'}${cls ? ` ${cls}` : ''}" style="${moodStyle(m)}" aria-hidden="true"></span>`;
}

// その日のFeelingを円環の上に置いた小さな図(右=快、上=高ぶり)
function circumplex(feelings) {
  const fs = [...new Set(feelings)];
  if (!fs.length) return '';
  const dots = fs.map(f => {
    const [v, a] = affectOf(f);
    const m = moodOf([f]);
    return `<circle cx="${(v * 26).toFixed(1)}" cy="${(-a * 26).toFixed(1)}" r="4" style="${moodStyle(m)}" class="cx__dot"><title>${esc(f)}</title></circle>`;
  }).join('');
  const all = moodOf(fs);
  return `<svg class="cx" viewBox="-34 -34 68 68" role="img" aria-label="この日のこころの位置: ${esc(fs.join('、'))}">
    <circle r="30" class="cx__ring"/><path d="M-30 0H30M0 -30V30" class="cx__axis"/>
    ${dots}<circle cx="${(all.v * 26).toFixed(1)}" cy="${(-all.a * 26).toFixed(1)}" r="2" class="cx__mean"/></svg>`;
}

// ---------- 記録 ----------
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => db.setMeta('draft', { id: form.id, datetime: form.datetime, text: form.text, feelings: [...form.feelings], thinkings: [...form.thinkings] }), 400);
}

function resetForm(date) {
  form.id = null;
  form.datetime = `${date || today()}T${nowTime()}`;
  form.text = '';
  form.feelings = new Set();
  form.thinkings = new Set();
}

function fillForm(e) {
  form.id = e.id;
  form.datetime = `${e.date}T${e.time || '00:00'}`;
  form.text = e.text || '';
  form.feelings = new Set(splitTags(e.feelings));
  form.thinkings = new Set(splitTags(e.thinkings));
}

// タグごとの使った回数
function tagCounts(kind) {
  const c = {};
  for (const e of state.entries) for (const t of splitTags(e[kind])) c[t] = (c[t] || 0) + 1;
  return c;
}

function orderedTags(kind, list) {
  return sortTags(list, state.tagOrder, state.tagOrder === 'often' ? tagCounts(kind) : {}, kind === 'feelings');
}

function chipsHtml(kind) {
  const set = form[kind];
  return orderedTags(kind, tagChoices(state.tags[kind], set)).map(n => `<button type="button" class="kind kind--${kind}${set.has(n) ? ' is-active' : ''}" data-kind="${kind}" data-tag="${esc(n)}" aria-pressed="${set.has(n)}"${kind === 'feelings' ? ` style="${moodStyle(moodOf([n]))}"` : ''}>${esc(n)}</button>`).join('')
    || '<p class="small muted" style="margin:0">タグはまだありません(設定で足せます)</p>';
}

async function renderWrite(arg) {
  setTab('write');
  const editing = arg && !isDate(arg) ? state.entries.find(e => e.id === arg) : null;
  if (editing) fillForm(editing);
  else if (isDate(arg)) { resetForm(arg); db.setMeta('draft', null); }
  else if (!form.id && !form.text) {
    const d = await db.getMeta('draft');
    if (d && (d.text || '').trim()) { Object.assign(form, d, { feelings: new Set(d.feelings), thinkings: new Set(d.thinkings) }); } else resetForm();
  }
  const sky = skyOf();
  const fdate = (form.datetime || '').slice(0, 10);
  setTitle(form.id ? '記録を直す' : `${SKY_LABEL[sky]}の記録`, { back: !!form.id, sub: isDate(fdate) ? daySub(fdate) : '' });
  const count = k => form[k].size ? ` ${form[k].size}` : '';
  $view.innerHTML = `
    <div class="card record">
      <div class="row"><label for="dt">日時</label><input id="dt" type="datetime-local" value="${esc(form.datetime)}"></div>
      <div class="row"><button type="button" class="cal-open" id="cal-open"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>この日の予定を見る</button></div>
    </div>
    <div class="card paper" id="paper" style="margin-top:var(--space-3);${moodStyle(moodOf([...form.feelings]))}">
      <textarea id="text" class="field field--note" placeholder="現在の意識を言語化…" aria-label="日記の本文">${esc(form.text)}</textarea>
    </div>
    <details class="fold" id="fold-f"><summary><span class="sum-orb">${orb([...form.feelings])}Feeling</span><small id="cnt-feelings">${count('feelings')}</small></summary><div class="fold__body"><div class="kinds" style="padding-top:0">${chipsHtml('feelings')}</div></div></details>
    <details class="fold" id="fold-t"><summary>Thinking<small id="cnt-thinkings">${count('thinkings')}</small></summary><div class="fold__body"><div class="kinds" style="padding-top:0">${chipsHtml('thinkings')}</div></div></details>
    <div class="actions">
      ${form.id || form.text ? '<button class="btn btn--tinted" id="cancel">取消</button>' : ''}
      ${form.id ? '<button class="btn btn--plain btn--destructive" id="remove">削除</button>' : ''}
      <button class="btn btn--prominent" id="save">${form.id ? '上書き保存' : '保存'}</button>
    </div>
    <p class="list-section__footer" id="sync-line"></p>`;
  watchSync(document.getElementById('sync-line'));

  const text = document.getElementById('text');
  text.addEventListener('input', () => { form.text = text.value; saveDraft(); });
  document.getElementById('dt').addEventListener('change', e => {
    form.datetime = e.target.value;
    if (isDate(form.datetime.slice(0, 10))) document.getElementById('nav-sub').innerHTML = daySub(form.datetime.slice(0, 10));
    saveDraft();
  });
  document.getElementById('paper').classList.toggle('has-mood', form.feelings.size > 0);
  $view.querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', () => {
    const set = form[b.dataset.kind];
    const n = b.dataset.tag;
    if (set.has(n)) set.delete(n); else set.add(n);
    b.classList.toggle('is-active', set.has(n));
    b.setAttribute('aria-pressed', set.has(n));
    document.getElementById(`cnt-${b.dataset.kind}`).textContent = set.size ? ` ${set.size}` : '';
    if (b.dataset.kind === 'feelings') {
      // 選んだ気持ちで、紙の縁と玉の色が混ざっていく
      const m = moodOf([...form.feelings]);
      document.querySelector('#fold-f .sum-orb').innerHTML = `${orb([...form.feelings])}Feeling`;
      const paper = document.getElementById('paper');
      paper.style.removeProperty('--h'); paper.style.removeProperty('--r');
      if (m) { paper.style.setProperty('--h', m.h); paper.style.setProperty('--r', m.r); }
      paper.classList.toggle('has-mood', !!m);
    }
    saveDraft();
  }));
  const cancel = document.getElementById('cancel');
  if (cancel) cancel.addEventListener('click', async () => {
    const back = form.id ? state.entries.find(e => e.id === form.id) : null;
    resetForm();
    await db.setMeta('draft', null);
    if (back) location.hash = `#day/${back.date}`; else renderWrite();
  });
  const remove = document.getElementById('remove');
  if (remove) remove.addEventListener('click', () => removeEntry(form.id));
  document.getElementById('cal-open').addEventListener('click', () => openAgenda(text));
  document.getElementById('save').addEventListener('click', saveEntry);
  if (!form.id && !form.text) text.focus({ preventScroll: true });
}

// ---------- その日の予定(Googleカレンダー、日記ハブ経由で読むだけ) ----------
function agendaLine(ev) {
  return ev.allDay ? `終日 ${ev.title}` : `${ev.start}〜${ev.end} ${ev.title}`;
}

async function openAgenda(textarea) {
  const date = (document.getElementById('dt').value || form.datetime).slice(0, 10);
  if (!isDate(date)) return;
  const pos = [textarea.selectionStart, textarea.selectionEnd];
  let dlg = document.getElementById('agenda');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'agenda';
    dlg.className = 'sheet agenda';
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); // 外側をタップで閉じる
    document.body.append(dlg);
  }
  const head = `<div class="sheet__grabber"></div><div class="agenda__head"><h2>${dateLabel(date)}の予定</h2><button class="btn btn--small btn--plain" id="agenda-close">閉じる</button></div>`;
  dlg.innerHTML = `${head}<div class="agenda__body"><p class="small muted">読み込み中…</p></div>`;
  dlg.showModal();
  dlg.querySelector('#agenda-close').addEventListener('click', () => dlg.close());
  const res = await sync.ask('calendar', { date }).catch(e => ({ ok: false, error: e.message }));
  if (res.ok && !Array.isArray(res.events)) { res.ok = false; res.error = '日記ハブがまだ古い版です'; }
  const body = dlg.querySelector('.agenda__body');
  if (!body) return;
  if (!res.ok) {
    const hint = /calendar|権限|permission|古い版|unknown action/i.test(res.error || '') ? '(日記ハブを新しい版で出し直し、カレンダーの権限を許可してください)' : '';
    body.innerHTML = `<p class="small muted">予定を読めませんでした: ${esc(res.error)}${hint}</p>`;
    return;
  }
  if (!res.events.length) { body.innerHTML = '<p class="small muted">この日の予定はありません。</p>'; return; }
  body.innerHTML = `<ul class="agenda__list">${res.events.map((ev, i) => `
    <li><button type="button" class="agenda__ev" data-i="${i}">
      <span class="agenda__bar" style="background:${/^#[0-9a-f]{3,8}$/i.test(ev.color) ? ev.color : 'var(--color-accent)'}"></span>
      <span class="agenda__time">${ev.allDay ? '終日' : `${esc(ev.start)}<br>${esc(ev.end)}`}</span>
      <span class="agenda__text"><b>${esc(ev.title)}</b><span class="small muted">${esc([ev.location, ev.calendar].filter(Boolean).join(' ・ '))}</span></span>
      <span class="agenda__add" aria-hidden="true">＋</span>
    </button></li>`).join('')}</ul>
    <p class="list-section__footer">予定をタップすると、本文に「${esc(agendaLine(res.events[0]))}」のように差し込みます。</p>`;
  body.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => {
    const line = agendaLine(res.events[Number(b.dataset.i)]);
    const v = textarea.value;
    const [a, z] = pos;
    const before = v.slice(0, a), after = v.slice(z);
    const ins = `${before && !before.endsWith('\n') ? '\n' : ''}${line}${after.startsWith('\n') ? '' : '\n'}`;
    textarea.value = before + ins + after;
    pos[0] = pos[1] = before.length + ins.length;
    form.text = textarea.value;
    saveDraft();
    b.classList.add('is-added');
    toast('本文に差し込みました', 1400);
  }));
}

async function saveEntry() {
  if (!form.text.trim()) { toast('本文を書いてください'); return; }
  const e = makeEntry({ ...form, datetime: document.getElementById('dt').value || form.datetime }, db.uid);
  await db.put('entries', e);
  const i = state.entries.findIndex(x => x.id === e.id);
  if (i >= 0) state.entries[i] = e; else state.entries.push(e);
  resetForm();
  await db.setMeta('draft', null);
  state.justSaved = e.id;
  toast(sync.enabled() ? '綴じました(数秒後に同期します)' : '綴じました');
  state.cal = null;
  location.hash = `#day/${e.date}`;
}

async function removeEntry(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e || !confirm('この記録を削除してもよろしいですか？')) return;
  await db.del('entries', id);
  state.entries = state.entries.filter(x => x.id !== id);
  if (form.id === id) { resetForm(); await db.setMeta('draft', null); }
  toast('削除しました');
  if (location.hash === `#day/${e.date}`) renderDay(e.date); else location.hash = `#day/${e.date}`;
}

// ---------- 日記(カレンダーとその日) ----------
function feelingsByDate() {
  const map = new Map();
  for (const e of state.entries) {
    if (!map.has(e.date)) map.set(e.date, []);
    map.get(e.date).push(...splitTags(e.feelings));
  }
  return map;
}

// カレンダーは「こころの色」のモザイク。記録のある日は、その日のFeelingの平均の色で塗る
function calendarHtml(date) {
  const [y, m] = state.cal;
  const byDate = feelingsByDate();
  const t = today();
  const cells = monthCells(y, m).map(d => {
    if (!d) return '<span class="cal__cell cal__cell--empty"></span>';
    const has = byDate.has(d);
    const mood = has ? moodOf(byDate.get(d)) : null;
    const cls = ['cal__cell', has ? (mood ? 'has-mood' : 'has-record') : '', d === date ? 'is-selected' : '', d === t ? 'is-today' : '', d > t ? 'is-future' : ''].filter(Boolean).join(' ');
    return `<a class="${cls}" href="#day/${d}" style="${moodStyle(mood)}" aria-label="${dateLabel(d)}${has ? '・記録あり' : ''}"${d === date ? ' aria-current="date"' : ''}><span>${Number(d.slice(8))}</span></a>`;
  }).join('');
  return `
    <div class="card cal">
      <div class="cal__head">
        <button class="cal__nav" data-shift="-12" aria-label="1年前">«</button>
        <button class="cal__nav" data-shift="-1" aria-label="前の月">‹</button>
        <span class="cal__label"><small>${y}</small>${m}月</span>
        <button class="cal__nav" data-shift="1" aria-label="次の月">›</button>
        <button class="cal__nav" data-shift="12" aria-label="1年後">»</button>
      </div>
      <div class="cal__grid cal__week" aria-hidden="true">${[...'日月火水木金土'].map(w => `<span>${w}</span>`).join('')}</div>
      <div class="cal__grid">${cells}</div>
    </div>`;
}

function entryHtml(e) {
  const feel = splitTags(e.feelings);
  const tags = [...feel.map(t => `<span class="tag tag--feel" style="${moodStyle(moodOf([t]))}">${esc(t)}</span>`), ...splitTags(e.thinkings).map(t => `<span class="tag tag--think">${esc(t)}</span>`)].join('');
  return `
    <article class="entry${state.justSaved === e.id ? ' is-new' : ''}" data-id="${esc(e.id)}" style="${moodStyle(moodOf(feel))}">
      <div class="entry__rail"><span class="entry__time">${esc(e.time)}</span>${orb(feel, 'orb--rail')}</div>
      <div class="entry__body card paper${feel.length ? ' has-mood' : ''}">
        <p class="entry__text">${esc(e.text)}</p>
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        <div class="note__tools">
          <button class="btn btn--small btn--tinted" data-insight="${esc(e.id)}">知的アドバイス</button>
          <a class="btn btn--small btn--plain" href="#write/${encodeURIComponent(e.id)}">直す</a>
          <button class="btn btn--small btn--plain" data-del="${esc(e.id)}">消す</button>
        </div>
        <div class="ai-slot"></div>
      </div>
    </article>`;
}

async function renderDay(arg) {
  setTab('day');
  const date = isDate(arg) ? arg : today();
  // 月送りボタンで動かしたときだけ、選んだ日と違う月を表示したままにする
  if (!state.cal || !state.calMoved) state.cal = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  state.calMoved = false;
  setTitle('日記', { sub: daySub(date) });
  const list = entriesOn(state.entries, date);
  const days = new Set(state.entries.map(e => e.date)).size;
  const feel = list.flatMap(e => splitTags(e.feelings));
  const mood = moodOf(feel);
  const words = [...new Set(feel)];
  $view.innerHTML = `
    ${calendarHtml(date)}
    <section class="day-head${mood ? ' has-mood' : ''}" style="${moodStyle(mood)}">
      <div class="day-head__text">
        <h2>${dateLabel(date)}</h2>
        <p class="small">${words.length ? `こころ: ${words.map(esc).join('・')}` : list.length ? `${list.length}件の記録` : 'まだ白いページです'}</p>
        <a class="btn btn--small btn--tinted" href="#write/${date}">＋ この日に書く</a>
      </div>
      ${circumplex(feel)}
    </section>
    ${list.length ? `<div class="thread">${list.map(entryHtml).join('')}</div>` : ''}
    <details class="fold side side--ensen" id="fold-ensen" open><summary>この日の縁<small>縁泉</small></summary><div class="fold__body"><div class="card" id="ensen-box"><p class="small muted" style="margin:0">読み込み中…</p></div></div></details>
    <details class="fold side side--books" id="fold-books" open><summary>この日に読み終えた本<small>読書ハブ</small></summary><div class="fold__body"><div class="card" id="books-box"><p class="small muted" style="margin:0">読み込み中…</p></div></div></details>
    <details class="fold side side--films" id="fold-films" open><summary>この日に観た映画<small>映画ハブ</small></summary><div class="fold__body"><div class="card" id="films-box"><p class="small muted" style="margin:0">読み込み中…</p></div></div></details>
    <details class="fold side side--news" id="fold-news"><summary>この日のニュース<small>Gemini</small></summary><div class="fold__body"><div class="card" id="news-box"><p class="small muted" style="margin:0">ボタンを押すとGeminiが検索します。送るのは日付だけです。</p></div><div class="actions"><button class="btn btn--tinted" id="news">主要ニュースを取得</button></div></div></details>
    <p class="list-section__footer">${days}日分の記録 ・ <span id="sync-line"></span></p>`;
  watchSync(document.getElementById('sync-line'));
  if (state.justSaved) {
    const el = $view.querySelector('.entry.is-new');
    state.justSaved = null;
    if (el) setTimeout(() => el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }), 250);
  }

  $view.querySelectorAll('[data-shift]').forEach(b => b.addEventListener('click', () => {
    state.cal = shiftMonth(state.cal[0], state.cal[1], Number(b.dataset.shift));
    state.calMoved = true;
    const y = scrollY;
    renderDay(date).then(() => scrollTo(0, y));
  }));
  $view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => removeEntry(b.dataset.del)));
  $view.querySelectorAll('[data-insight]').forEach(b => b.addEventListener('click', () => insight(b)));
  document.getElementById('news').addEventListener('click', () => news(date));
  loadEnsen(date);
  loadBooks(date);
  loadFilms(date);
}

async function side(kind, date) {
  const key = `${kind}:${date}`;
  if (!state.side[key]) state.side[key] = sync.ask(kind, { date }).catch(e => { delete state.side[key]; return { ok: false, error: e.message }; });
  return state.side[key];
}

async function loadEnsen(date) {
  const res = await side('ensen', date);
  const box = document.getElementById('ensen-box');
  if (!box) return;
  if (!res.ok) { box.innerHTML = `<p class="small muted" style="margin:0">縁泉を読めませんでした: ${esc(res.error)}</p>`; return; }
  const parts = (res.events || []).map(ev => {
    const where = ev.place && ev.place !== ev.name ? ` <span class="muted small">・${esc(ev.place)}</span>` : '';
    const media = ev.media ? ` <a href="${esc(ev.media)}" target="_blank" rel="noopener" aria-label="写真">📷</a>` : '';
    return `<div class="ev"><span class="ev__time">${esc(ev.time)}</span> <span class="muted small">${esc(ev.type)}</span> <b>${esc(ev.name)}</b> <span class="ev__verb">${esc(ev.verb)}</span>${where}${media}${ev.note ? `<div class="small muted">${esc(ev.note)}</div>` : ''}</div>`;
  });
  if ((res.homeMoves || []).length) parts.push(`<div class="small muted">🏠 ${res.homeMoves.map(m => `${esc(m.time)} ${esc(m.kind)}`).join(' / ')}</div>`);
  const traces = res.traces || [];
  if (traces.length && res.uiUrl) {
    // 写真の痕跡。縁泉に残したい1枚だけタップすると、縁泉の記録画面が下書き入りで開く
    const tiles = traces.map(t => {
      const img = t.thumb ? `<img src="data:image/jpeg;base64,${esc(t.thumb)}" alt="">` : '<span aria-hidden="true">📷</span>';
      return `<a class="trace" href="${esc(`${res.uiUrl}?trace=${encodeURIComponent(t.id)}`)}" target="_blank" rel="noopener"><span class="trace__img">${img}${t.promoted ? '<span class="trace__badge">縁</span>' : ''}</span><span class="trace__cap"><span class="ev__time">${esc(t.time)}</span> ${esc(t.place)}</span></a>`;
    }).join('');
    parts.push(`<div class="small muted" style="margin-top:var(--space-2)">写真の痕跡(縁泉に残したい1枚をタップ)</div><div class="traces">${tiles}</div>`);
  }
  box.innerHTML = (parts.length ? parts.join('') : '<p class="small muted" style="margin:0">この日の縁泉の記録はありません。</p>')
    + (res.uiUrl ? `<p class="small" style="margin:var(--space-2) 0 0"><a href="${esc(res.uiUrl)}" target="_blank" rel="noopener">縁泉を開く ↗</a></p>` : '');
}

async function loadBooks(date) {
  const res = await side('books', date);
  const box = document.getElementById('books-box');
  if (!box) return;
  if (!res.ok) { box.innerHTML = `<p class="small muted" style="margin:0">読書ハブを読めませんでした: ${esc(res.error)}</p>`; return; }
  box.innerHTML = res.books.length ? res.books.map(b => `
    <a class="book" href="${esc(b.url)}" target="_blank" rel="noopener">
      <span class="cover cover--sm">${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
      <span class="book__text"><b>${esc(b.title)}</b> <span class="muted small">↗</span><span class="small muted" style="display:block">${esc(b.author)}${b.category ? ` ・${esc(b.category)}` : ''}</span>${b.note ? `<span class="small book__note">${esc(b.note)}</span>` : ''}</span>
    </a>`).join('') : '<p class="small muted" style="margin:0">この日に読み終えた本はありません。</p>';
}

async function loadFilms(date) {
  const res = await side('films', date);
  const box = document.getElementById('films-box');
  if (!box) return;
  if (res.ok && !Array.isArray(res.films)) { res.ok = false; res.error = '日記ハブを新しい版で出し直すと表示されます'; }
  if (!res.ok) { box.innerHTML = `<p class="small muted" style="margin:0">映画ハブを読めませんでした: ${esc(res.error)}</p>`; return; }
  box.innerHTML = res.films.length ? res.films.map(f => `
    <a class="book" href="${esc(f.url)}" target="_blank" rel="noopener">
      <span class="cover cover--sm">${f.poster ? `<img src="${esc(f.poster)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
      <span class="book__text"><b>${esc(f.title)}</b>${f.score !== '' ? ` <span class="film__score">${esc(f.score)}<small>/10</small></span>` : ''} <span class="muted small">↗</span>
        <span class="small muted" style="display:block">${esc([f.year, f.directors].filter(Boolean).join(' ・ '))}</span>
        <span class="small muted" style="display:block">${esc([f.place, f.venue].filter(Boolean).join(' ・ '))}${f.genres ? ` ・ ${esc(f.genres)}` : ''}</span>
        ${f.text ? `<span class="small book__note">${esc(f.text)}</span>` : ''}</span>
    </a>`).join('') : '<p class="small muted" style="margin:0">この日に観た映画はありません。</p>';
}

async function aiConfig() {
  const [apiKey, model] = await Promise.all([db.getMeta('geminiKey', ''), db.getMeta('geminiModel', '')]);
  return { apiKey, model: model || gemini.DEFAULT_MODEL };
}

function answerHtml(label, r) {
  const src = r.sources && r.sources.length ? `<span class="ai-answer__label" style="margin-top:var(--space-2)">参照: ${r.sources.slice(0, 5).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' ・ ')}</span>` : '';
  return `<div class="ai-answer"><span class="ai-answer__label">${label}${r.searched ? '' : '(検索なしで答えています)'}</span>${renderAnswer(r.text || '答えを作れませんでした')}${src}</div>`;
}

async function insight(btn) {
  const e = state.entries.find(x => x.id === btn.dataset.insight);
  const slot = btn.closest('.entry__body').querySelector('.ai-slot');
  const cfg = await aiConfig();
  if (!cfg.apiKey) { toast('設定でGemini APIキーを入れてください'); return; }
  btn.disabled = true;
  slot.innerHTML = '<div class="ai-answer"><span class="ai-answer__label">Gemini が考えています…(この記録の本文を送っています)</span></div>';
  try {
    const r = await gemini.generateGrounded({ ...cfg, prompt: buildPrompt(state.prompts, 'Geminiサジェスト', { text: e.text }) });
    slot.innerHTML = answerHtml('Thought Catalyst', r);
  } catch (err) { slot.innerHTML = `<div class="ai-answer">${esc(err.message)}</div>`; }
  btn.disabled = false;
}

async function news(date) {
  const box = document.getElementById('news-box');
  const btn = document.getElementById('news');
  const cfg = await aiConfig();
  if (!cfg.apiKey) { toast('設定でGemini APIキーを入れてください'); return; }
  btn.disabled = true;
  box.innerHTML = '<p class="small muted" style="margin:0">検索しています…</p>';
  try {
    const r = await gemini.generateGrounded({ ...cfg, prompt: buildPrompt(state.prompts, 'Geminiニュース検索', { dateStr: date }) });
    box.innerHTML = answerHtml('Historical Context', r);
    btn.textContent = '取り直す';
  } catch (err) { box.innerHTML = `<p class="small" style="margin:0">${esc(err.message)}</p>`; }
  btn.disabled = false;
}

// ---------- こころの色(タグの位置を動かす) ----------
let palSel = null;

function paletteSvg() {
  // 外周に色相の輪。円の向きでどの色になるかが分かる
  const ring = Array.from({ length: 72 }, (_, i) => {
    const t0 = i * 5 * Math.PI / 180, t1 = (i + 1) * 5 * Math.PI / 180;
    const v = Math.cos((t0 + t1) / 2), a = Math.sin((t0 + t1) / 2);
    const p = (r, t) => `${(Math.cos(t) * r).toFixed(3)},${(-Math.sin(t) * r).toFixed(3)}`;
    return `<path d="M${p(1.04, t0)}L${p(1.16, t0)}A1.16,1.16 0 0 0 ${p(1.16, t1)}L${p(1.04, t1)}A1.04,1.04 0 0 1 ${p(1.04, t0)}Z" class="pal__hue" style="--h:${hueOf(v, a)};--r:1"/>`;
  }).join('');
  const dots = state.tags.feelings.map(n => {
    const [v, a] = affectOf(n);
    return `<g class="pal__dot${n === palSel ? ' is-sel' : ''}${state.affect[n] ? ' is-custom' : ''}" data-name="${esc(n)}" transform="translate(${v} ${-a})" style="${moodStyle(moodOf([n]))}"><circle r="${n === palSel ? 0.075 : 0.045}"/>${n === palSel ? `<text y="-0.11" text-anchor="middle">${esc(n)}</text>` : ''}</g>`;
  }).join('');
  return `${ring}<circle r="1" class="pal__ring"/><path d="M-1 0H1M0 -1V1" class="pal__axis"/>
    <text x="0.97" y="-0.04" text-anchor="end" class="pal__lab">快</text><text x="-0.97" y="-0.04" class="pal__lab">不快</text>
    <text x="0.04" y="-0.9" class="pal__lab">高ぶり</text><text x="0.04" y="0.96" class="pal__lab">静まり</text>${dots}`;
}

function paletteChips() {
  return orderedTags('feelings', state.tags.feelings).map(n => `<button type="button" class="kind kind--feelings${n === palSel ? ' is-active' : ''}" data-pal="${esc(n)}" style="${moodStyle(moodOf([n]))}">${esc(n)}</button>`).join('')
    || '<p class="small muted" style="margin:0">Feelingタグがまだありません。</p>';
}

function redrawPalette() {
  document.getElementById('pal').innerHTML = paletteSvg();
  document.getElementById('pal-tags').innerHTML = paletteChips();
  document.getElementById('pal-reset').disabled = !(palSel && state.affect[palSel]);
  document.getElementById('pal-reset-all').disabled = !Object.keys(state.affect).length;
  document.getElementById('pal-hint').textContent = palSel ? `「${palSel}」を円の中でなぞって置き場所を決めてください。` : '下のタグを選んでから、円の中を指でなぞると置き場所と色が変わります。';
  document.querySelectorAll('[data-pal]').forEach(b => b.addEventListener('click', () => { palSel = b.dataset.pal === palSel ? null : b.dataset.pal; redrawPalette(); }));
}

async function saveAffect() {
  setCustomAffect(state.affect);
  await db.setMeta('affect', state.affect);
}

function bindPalette() {
  const svg = document.getElementById('pal');
  redrawPalette();
  let drag = false;
  const place = e => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    state.affect = { ...state.affect, [palSel]: clampAffect(p.x, -p.y) };
    setCustomAffect(state.affect);
    svg.innerHTML = paletteSvg();
  };
  svg.addEventListener('pointerdown', e => {
    const dot = e.target.closest('.pal__dot');
    if (dot) palSel = dot.dataset.name;
    if (!palSel) { toast('先に下のタグを選んでください'); return; }
    drag = true;
    svg.setPointerCapture(e.pointerId);
    place(e);
  });
  svg.addEventListener('pointermove', e => { if (drag) place(e); });
  const end = async () => { if (!drag) return; drag = false; await saveAffect(); redrawPalette(); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  document.getElementById('pal-reset').addEventListener('click', async () => {
    if (!palSel) return;
    const { [palSel]: _, ...rest } = state.affect;
    state.affect = rest;
    await saveAffect();
    redrawPalette();
  });
  document.getElementById('pal-reset-all').addEventListener('click', async () => {
    if (!confirm('すべてのタグの位置を最初の配置に戻しますか。')) return;
    state.affect = {};
    await saveAffect();
    redrawPalette();
  });
}

// ---------- 設定 ----------
async function renderSettings() {
  setTab('settings');
  setTitle('設定');
  const [key, model, lastBackup, persisted, syncUrl, syncToken, pendingTags] = await Promise.all([
    db.getMeta('geminiKey', ''), db.getMeta('geminiModel', ''), db.getMeta('lastBackupAt'),
    navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
    db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''), db.getMeta('pendingTags', []),
  ]);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $view.innerHTML = `
    <details class="fold" id="sync-fold" ${syncUrl ? '' : 'open'}><summary>日記ハブ(同期)<small id="sync-sum"></small></summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="s-url">URL</label><input id="s-url" type="url" autocomplete="off" value="${esc(syncUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="row"><label for="s-token">合言葉</label><input id="s-token" type="password" autocomplete="off" value="${esc(syncToken)}" placeholder="setup の実行ログに出たもの"></div>
      </div>
      <p class="list-section__footer" id="sync-line"></p>
      <div class="actions">${syncUrl ? '<button class="btn btn--tinted" id="s-now">今すぐ同期</button><button class="btn btn--plain" id="s-off">同期をやめる</button>' : '<button class="btn btn--prominent" id="s-on">接続して同期する</button>'}</div>
      <p class="list-section__footer">いまの「日記の記録」スプレッドシートと同期します。GASの日記アプリで書いた分もここに届き、ここで書いた分もGASの日記アプリに出ます。準備の手順は<a href="https://github.com/tadamasa/diary-home/blob/main/hub/README.md" target="_blank" rel="noopener">こちら</a>。</p>
    </div></details>
    <details class="fold"><summary>タグを足す</summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="t-cat">種類</label><select id="t-cat"><option value="Thinking">Thinking</option><option value="Feeling">Feeling</option></select></div>
        <div class="row"><label for="t-name">名前</label><input id="t-name" autocomplete="off" placeholder="ラベル名"></div>
      </div>
      <div class="actions"><button class="btn btn--tinted" id="t-add">追加</button></div>
      <p class="list-section__footer">「タグ管理」シートに足します${pendingTags.length ? `(未送信 ${pendingTags.length}件)` : ''}。Feeling ${state.tags.feelings.length}個 ・ Thinking ${state.tags.thinkings.length}個。</p>
    </div></details>
    <details class="fold" id="color-fold"><summary>こころの色</summary><div class="fold__body">
      <div class="card palette">
        <svg class="pal" id="pal" viewBox="-1.25 -1.25 2.5 2.5" role="img" aria-label="Feelingの位置。右が快、左が不快、上が高ぶり、下が静まり">${paletteSvg()}</svg>
        <p class="small muted" id="pal-hint" style="margin:var(--space-2) 0 0">下のタグを選んでから、円の中を指でなぞると置き場所と色が変わります。</p>
      </div>
      <div class="segmented-wrap" style="padding-top:var(--space-3)"><div class="segmented segmented--wide" role="radiogroup" aria-label="タグの並べ方">${[['color', '色の順'], ['often', 'よく使う順'], ['sheet', 'シートの順']].map(([k, l]) => `<button type="button" class="segmented__item${state.tagOrder === k ? ' is-active' : ''}" role="radio" aria-checked="${state.tagOrder === k}" data-order="${k}">${l}</button>`).join('')}</div></div>
      <div class="kinds" id="pal-tags">${paletteChips()}</div>
      <div class="actions"><button class="btn btn--tinted" id="pal-reset" disabled>元に戻す</button><button class="btn btn--plain" id="pal-reset-all"${Object.keys(state.affect).length ? '' : ' disabled'}>すべて元に戻す</button></div>
      <p class="list-section__footer">感情の円環モデル(Russell 1980)の2軸に置いています。右ほど快、上ほど高ぶり。円の向きが色合いに、中心からの遠さが色の濃さになります。変えた位置はこの端末に保存され、書き出しファイルにも入ります。</p>
    </div></details>
    <details class="fold"><summary>AI(Gemini)</summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="g-key">APIキー</label><input id="g-key" type="password" autocomplete="off" value="${esc(key)}" placeholder="Google AI Studioで取得"></div>
        <div class="row"><label for="g-model">モデル</label><input id="g-model" value="${esc(model)}" placeholder="${gemini.DEFAULT_MODEL}"></div>
      </div>
      <p class="list-section__footer">「知的アドバイス」を押すとその記録の本文を、「主要ニュースを取得」を押すと日付だけをGeminiに送ります。無料枠では、送った内容がGoogleの製品改善に使われ、人が読むこともあります。指示文は「プロンプト管理」シートのものを使います。キーはこの端末にだけ保存され、書き出しファイルにも含まれません。</p>
    </div></details>
    <details class="fold"><summary>バックアップ</summary><div class="fold__body">
      <div class="card">
        <p class="small muted" style="margin:0">全部の記録をファイルに書き出し、「ファイル」アプリ(iCloud Drive)に保存できます。</p>
        <p class="small" style="margin:var(--space-2) 0 0">最後の書き出し: ${lastBackup ? new Date(lastBackup).toLocaleDateString('ja-JP') : 'まだありません'}</p>
      </div>
      <div class="actions"><button class="btn btn--prominent" id="export">書き出す</button><label class="btn btn--tinted">読み込む<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      ${!standalone ? '<p class="list-section__footer">Safariの共有ボタンから「ホーム画面に追加」してから使ってください。追加しないと、しばらく開かないうちにデータが消えることがあります。</p>' : ''}
      <p class="list-section__footer">保存領域の保護: ${persisted ? '有効' : '未許可'}</p>
    </div></details>
    <details class="fold"><summary>このアプリについて</summary><div class="fold__body">
      <p class="list-section__footer">記録 ${state.entries.length}件(${new Set(state.entries.map(e => e.date)).size}日分)。記録はこの端末の中が正本で、圏外でも書けます。つながったときに日記ハブと差分だけをやり取りします。</p>
    </div></details>`;

  const line = document.getElementById('sync-line');
  const sum = document.getElementById('sync-sum');
  watchSync(line);
  const off0 = sync.onStatus(st => { if (!document.body.contains(sum)) return off0(); sum.textContent = st.state === 'off' ? '' : st.state === 'error' ? 'エラー' : st.state === 'syncing' ? '同期中' : '接続中'; });
  sum.textContent = sync.status.state === 'off' ? '' : '接続中';
  const reopen = () => renderSettings().then(() => { document.getElementById('sync-fold').open = true; });
  const on = document.getElementById('s-on');
  if (on) on.addEventListener('click', async () => {
    const url = document.getElementById('s-url').value.trim();
    const token = document.getElementById('s-token').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url) || !token) { toast('URL(script.google.com)と合言葉を入れてください'); return; }
    on.disabled = true;
    await sync.connect(url, token);
    if (sync.status.state === 'error') { toast(sync.status.error); on.disabled = false; return; }
    await load();
    toast(`日記ハブにつなぎました(記録 ${state.entries.length}件)`);
    reopen();
  });
  const now = document.getElementById('s-now');
  if (now) now.addEventListener('click', () => sync.syncNow());
  const off = document.getElementById('s-off');
  if (off) off.addEventListener('click', async () => {
    if (!confirm('同期をやめますか。この端末のデータとスプレッドシートはどちらも残ります。')) return;
    await sync.disconnect();
    reopen();
  });
  bindPalette();
  document.querySelectorAll('[data-order]').forEach(b => b.addEventListener('click', async () => {
    state.tagOrder = b.dataset.order;
    await db.setMeta('tagOrder', state.tagOrder);
    document.querySelectorAll('[data-order]').forEach(x => { x.setAttribute('aria-checked', x === b); x.classList.toggle('is-active', x === b); });
    redrawPalette();
  }));
  document.getElementById('t-add').addEventListener('click', async () => {
    const category = document.getElementById('t-cat').value;
    const name = document.getElementById('t-name').value.trim();
    if (!name) return;
    const k = category === 'Feeling' ? 'feelings' : 'thinkings';
    if (!state.tags[k].includes(name)) state.tags[k].push(name);
    await db.setMeta('tags', state.tags);
    await db.setMeta('pendingTags', [...(await db.getMeta('pendingTags', [])), { category, name }]);
    sync.schedule(300);
    toast(`定義しました: ${name}`);
    renderSettings();
  });
  const saveKey = async () => {
    await db.setMeta('geminiKey', document.getElementById('g-key').value.trim());
    await db.setMeta('geminiModel', document.getElementById('g-model').value.trim());
    toast('保存しました');
  };
  document.getElementById('g-key').addEventListener('change', saveKey);
  document.getElementById('g-model').addEventListener('change', saveKey);
  document.getElementById('export').addEventListener('click', async () => {
    try { if (await exportData()) { toast('書き出しました'); renderSettings(); } } catch (e) { toast(e.message); }
  });
  document.getElementById('import').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { const n = await importData(await f.text()); await load(); toast(`${n}件を読み込みました`); renderSettings(); } catch (err) { toast(err.message); }
  });
}

// ---------- ルーティング ----------
async function route() {
  const [name, arg] = location.hash.replace(/^#/, '').split('/');
  const a = arg ? decodeURIComponent(arg) : '';
  if (name !== 'day') window.scrollTo(0, 0);
  watchSync(null);
  switch (name) {
    case 'day': return renderDay(a);
    case 'settings': return renderSettings();
    default: return renderWrite(a);
  }
}

document.getElementById('back').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#day'));
addEventListener('hashchange', () => {
  // 日記タブ内で日付を変えたときは、カレンダーの位置を保つ
  const keep = location.hash.startsWith('#day/');
  const y = scrollY;
  route().then(() => { if (keep) scrollTo(0, y); });
});

// Large Title の折り畳み
const nav = document.getElementById('nav');
const sentinel = document.createElement('div');
sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
document.body.prepend(sentinel);
new IntersectionObserver(([e]) => nav.classList.toggle('is-collapsed', !e.isIntersecting), { threshold: 0 }).observe(sentinel);

// ハブから変更を受け取ったら読み直す。入力中は画面を作り直さない(次に画面を移ったときに反映される)
async function onRemoteChange() {
  await load();
  state.side = {};
  const a = document.activeElement;
  const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  if (!typing && location.hash.startsWith('#day')) { const y = scrollY; await route(); scrollTo(0, y); }
}

(async function start() {
  applySky();
  setInterval(applySky, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') applySky(); });
  await load();
  db.requestPersist();
  // Safariのタブはホーム画面のアプリと保存場所が別で、使わないと7日で消える
  if (!(matchMedia('(display-mode: standalone)').matches || navigator.standalone)) document.getElementById('tab-warning').hidden = false;
  await sync.initSync({ onRemoteChange });
  route();
  sync.schedule(300);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.schedule(300); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

window.__app = { state, form };
