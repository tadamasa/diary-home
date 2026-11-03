import * as db from './db.js';
import * as sync from './sync.js';
import * as gemini from './gemini.js';
import { exportData, importData } from './backup.js';
import { moodOf, moodStyle, skyOf, SKY_LABEL, moonAge, moonName, moonPath, affectOf, setCustomAffect, clampAffect, hueOf, sortTags } from './mood.js';
import { searchEntries, snippetHtml, markHtml, timeline, coFeelings, encodeSearch, decodeSearch } from './search.js';
import { esc, today, nowTime, isDate, dateLabel, monthCells, weekCells, shiftMonth, splitTags, entriesOn, tagChoices, buildPrompt, renderAnswer, makeEntry, shiftDay, swipeDir, insertLine, ensenEventsShown } from './diary.js';

// ---------- 状態 ----------
const state = {
  entries: [],
  tags: { feelings: [], thinkings: [] },
  prompts: {},
  cal: null, // [年, 月] 日記タブで表示中の月
  side: {}, // 日付ごとの縁泉・読了本(開いている間だけ覚える)
  marks: {}, // 月ごとの読了本・映画の日 { 'YYYY-MM': { books: Set, films: Set } }
  compose: null, // 書く欄を開いている日 { date, id }
  draft: null, // 書きかけ(meta draft と同じもの)
  calIds: [], // 予定を読むGoogleカレンダー(空ならハブの既定)
  calWeek: false, // カレンダーを選んだ日の週だけに畳む
};
const form = { id: null, datetime: '', text: '', feelings: new Set(), thinkings: new Set(), caret: null };

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
  for (const a of document.querySelectorAll('.tabbar__item, .tabbar__search')) {
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
  state.calIds = (await db.getMeta('calendarIds')) || [];
  state.calWeek = !!(await db.getMeta('calWeek'));
  state.draft = await db.getMeta('draft');
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

// ---------- 書く(その日のページの中で) ----------
// 書く欄は、日記タブの選んだ日の見出しのすぐ下に開く。下に並ぶ予定・縁泉・本・映画を見ながら書ける。
// state.compose = { date, id }(id があれば直している記録)。書きかけは meta draft に1つだけ残す
let draftTimer = null;
function snapshot() {
  return { id: form.id, datetime: form.datetime, text: form.text, feelings: [...form.feelings], thinkings: [...form.thinkings] };
}
function saveDraft() {
  state.draft = snapshot();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => db.setMeta('draft', state.draft), 400);
}
function clearDraft() {
  clearTimeout(draftTimer);
  state.draft = null;
  return db.setMeta('draft', null);
}
const draftDate = () => (state.draft && (state.draft.text || '').trim() ? state.draft.datetime.slice(0, 10) : '');

function resetForm(date) {
  form.id = null;
  form.datetime = `${date || today()}T${nowTime()}`;
  form.text = '';
  form.feelings = new Set();
  form.thinkings = new Set();
  form.caret = null;
}

function fillForm(e) {
  form.id = e.id;
  form.datetime = `${e.date}T${e.time || '00:00'}`;
  form.text = e.text || '';
  form.feelings = new Set(splitTags(e.feelings));
  form.thinkings = new Set(splitTags(e.thinkings));
  form.caret = null;
}

// その日に書き始める / 記録を直し始める。別の書きかけがあれば、捨てるか確かめる
function openCompose(date, id = null) {
  const d = state.draft;
  const dd = draftDate();
  const same = dd && dd === date && (d.id || null) === id;
  if (dd && !same) {
    if (!confirm(`${dateLabel(dd)}に書きかけの記録があります。それを捨てて、こちらを書きますか。`)) { location.hash = `#day/${dd}`; return false; }
    clearDraft();
  }
  const e = id ? state.entries.find(x => x.id === id) : null;
  if (same) Object.assign(form, d, { feelings: new Set(d.feelings), thinkings: new Set(d.thinkings), caret: null });
  else if (e) fillForm(e);
  else resetForm(date);
  state.compose = { date, id: e ? e.id : null };
  return true;
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

function composerHtml() {
  const editing = !!form.id;
  const date = form.datetime.slice(0, 10);
  const count = k => form[k].size ? ` ${form[k].size}` : '';
  const hint = date === today() ? `${SKY_LABEL[skyOf()]}の意識を言語化…` : 'この日のことを、下の予定や縁を見ながら思い出して…';
  return `
    <section class="composer${editing ? ' composer--edit' : ''}" id="composer" aria-label="${editing ? '記録を直す' : 'この日に書く'}">
      <div class="composer__head">
        <span class="composer__title">${editing ? '記録を直す' : 'この日に書く'}</span>
        <label class="composer__time"><span class="small muted">時刻</span><input id="c-time" type="time" value="${esc(form.datetime.slice(11, 16))}"></label>
      </div>
      <div class="card paper${form.feelings.size ? ' has-mood' : ''}" id="paper" style="${moodStyle(moodOf([...form.feelings]))}">
        <textarea id="text" class="field field--note" placeholder="${esc(hint)}" aria-label="日記の本文">${esc(form.text)}</textarea>
      </div>
      <details class="fold" id="fold-f"><summary><span class="sum-orb">${orb([...form.feelings])}Feeling</span><small id="cnt-feelings">${count('feelings')}</small></summary><div class="fold__body"><div class="kinds" style="padding-top:0">${chipsHtml('feelings')}</div></div></details>
      <details class="fold" id="fold-t"><summary>Thinking<small id="cnt-thinkings">${count('thinkings')}</small></summary><div class="fold__body"><div class="kinds" style="padding-top:0">${chipsHtml('thinkings')}</div></div></details>
      <div class="actions">
        <button class="btn btn--tinted" id="cancel">${editing ? 'やめる' : '取消'}</button>
        ${editing ? '<button class="btn btn--plain btn--destructive" id="remove">削除</button>' : ''}
        <button class="btn btn--prominent" id="save">${editing ? '上書き保存' : '保存'}</button>
      </div>
    </section>`;
}

function bindComposer(date) {
  const text = document.getElementById('text');
  if (!text) return;
  const keepCaret = () => { form.caret = [text.selectionStart, text.selectionEnd]; };
  text.addEventListener('input', () => { form.text = text.value; keepCaret(); saveDraft(); });
  text.addEventListener('blur', keepCaret);
  text.addEventListener('keyup', keepCaret);
  text.addEventListener('pointerup', keepCaret);
  document.getElementById('c-time').addEventListener('change', e => {
    if (/^\d{2}:\d{2}/.test(e.target.value)) { form.datetime = `${date}T${e.target.value.slice(0, 5)}`; saveDraft(); }
  });
  $view.querySelectorAll('#composer [data-tag]').forEach(b => b.addEventListener('click', () => {
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
  document.getElementById('cancel').addEventListener('click', async () => {
    if (!form.id && form.text.trim() && !confirm('書きかけを捨てますか。')) return;
    await closeCompose(date);
  });
  const remove = document.getElementById('remove');
  if (remove) remove.addEventListener('click', () => removeEntry(form.id));
  document.getElementById('save').addEventListener('click', () => saveEntry(date));
}

async function closeCompose(date) {
  state.compose = null;
  resetForm(date);
  await clearDraft();
  rerenderDay(date);
}

// 同じ日のまま描き直す(スクロール位置を保つ)。描き直しは同期的に終わるので、続けて focus してもキーボードが出る
function rerenderDay(date) {
  const y = scrollY;
  renderDay(date);
  scrollTo(0, y);
}

function startCompose(date, id = null) {
  if (!openCompose(date, id)) return;
  rerenderDay(date);
  const text = document.getElementById('text');
  if (!text) return;
  text.focus({ preventScroll: true });
  const len = text.value.length;
  if (!id) text.setSelectionRange(len, len);
  document.getElementById('composer').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// 予定や縁泉の1行を、書いている本文のカーソル位置に差し込む。書く欄が閉じていれば開く
function quoteLine(date, line) {
  if (!state.compose) { if (!openCompose(date)) return; rerenderDay(date); }
  const text = document.getElementById('text');
  if (!text) return;
  const r = insertLine(text.value, form.caret || [text.value.length, text.value.length], line);
  text.value = form.text = r.text;
  form.caret = [r.caret, r.caret];
  saveDraft();
  toast('本文に差し込みました', 1400);
}

async function saveEntry(date) {
  if (!form.text.trim()) { toast('本文を書いてください'); return; }
  const t = document.getElementById('c-time');
  const time = t && /^\d{2}:\d{2}/.test(t.value) ? t.value.slice(0, 5) : form.datetime.slice(11, 16);
  const e = makeEntry({ ...form, datetime: `${date}T${time}` }, db.uid);
  await db.put('entries', e);
  const i = state.entries.findIndex(x => x.id === e.id);
  if (i >= 0) state.entries[i] = e; else state.entries.push(e);
  state.compose = null;
  resetForm(date);
  await clearDraft();
  state.justSaved = e.id;
  toast(sync.enabled() ? '綴じました(数秒後に同期します)' : '綴じました');
  rerenderDay(date);
}

async function removeEntry(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e || !confirm('この記録を削除してもよろしいですか？')) return;
  await db.del('entries', id);
  state.entries = state.entries.filter(x => x.id !== id);
  if (form.id === id) { state.compose = null; resetForm(e.date); await clearDraft(); }
  toast('削除しました');
  if (location.hash === `#day/${e.date}`) rerenderDay(e.date); else location.hash = `#day/${e.date}`;
}

// ---------- その日の予定(Googleカレンダー、日記ハブ経由で読むだけ) ----------
function agendaLine(ev) {
  return ev.allDay ? `終日 ${ev.title}` : `${ev.start}〜${ev.end} ${ev.title}`;
}

// その日のまわりの折り畳み: はじめは閉じておき、中身があれば開く。なければ閉じたまま「なし」と薄く出す
function settle(kind, n) {
  const fold = document.getElementById(`fold-${kind}`);
  if (!fold) return;
  const src = fold.dataset.src;
  fold.classList.toggle('is-empty', n === 0);
  fold.querySelector('summary small').textContent = n < 0 ? '読めませんでした' : n ? [`${n}件`, src].filter(Boolean).join(' ・ ') : 'なし';
  fold.open = n > 0;
}

async function loadAgenda(date) {
  const res = await side('calendar', date, state.calIds.length ? { ids: state.calIds } : {});
  const box = document.getElementById('agenda-box');
  if (!box || box.dataset.day !== date) return; // 返事が届く前に別の日へ移っていたら捨てる
  if (res.ok && !Array.isArray(res.events)) { res.ok = false; res.error = '日記ハブがまだ古い版です'; }
  if (!res.ok) {
    const hint = /calendar|権限|permission|古い版|unknown action/i.test(res.error || '') ? '(日記ハブを新しい版で出し直し、カレンダーの権限を許可してください)' : '';
    box.innerHTML = `<p class="small muted" style="margin:0">予定を読めませんでした: ${esc(res.error)}${hint}</p>`;
    settle('agenda', -1);
    return;
  }
  settle('agenda', res.events.length);
  if (!res.events.length) { box.innerHTML = '<p class="small muted" style="margin:0">この日の予定はありません。</p>'; return; }
  box.innerHTML = `<ul class="agenda__list">${res.events.map((ev, i) => `
    <li><button type="button" class="agenda__ev" data-ev="${i}" aria-label="${esc(agendaLine(ev))} を本文に差し込む">
      <span class="agenda__bar" style="background:${/^#[0-9a-f]{3,8}$/i.test(ev.color) ? ev.color : 'var(--color-accent)'}"></span>
      <span class="agenda__time">${ev.allDay ? '終日' : `${esc(ev.start)}<br>${esc(ev.end)}`}</span>
      <span class="agenda__text"><b>${esc(ev.title)}</b><span class="small muted">${esc([ev.location, ev.calendar].filter(Boolean).join(' ・ '))}</span></span>
      <span class="agenda__add" aria-hidden="true">＋</span>
    </button></li>`).join('')}</ul>`;
  box.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', () => {
    quoteLine(date, agendaLine(res.events[Number(b.dataset.ev)]));
    const again = document.querySelector(`#agenda-box [data-ev="${b.dataset.ev}"]`);
    if (again) again.classList.add('is-added');
  }));
}

// ---------- 日記(カレンダーとその日) ----------
// 月ごとの「本を読み終えた日・映画を観た日」。端末に覚えておき(圏外でも出る)、開くたびに一度だけハブに聞き直す
const marksAsked = new Set();
function monthMarks(y, m) {
  const ym = `${y}-${String(m).padStart(2, '0')}`;
  const cached = state.marks[ym];
  if (!marksAsked.has(ym) && sync.enabled()) {
    marksAsked.add(ym);
    (async () => {
      if (!cached) {
        const saved = await db.getMeta(`marks:${ym}`);
        if (saved) { state.marks[ym] = { books: new Set(saved.books), films: new Set(saved.films) }; refreshCalendar(); }
      }
      const res = await sync.ask('month', { month: ym }).catch(() => null);
      // 古い版のハブは month を知らず、同期の返事を返す(books がない)
      if (res && res.ok && !Array.isArray(res.books)) { state.marksNote = '読書・映画の点は、日記ハブを新しい版で出し直すと出ます'; refreshCalendar(); }
      if (!res || !res.ok || !Array.isArray(res.books)) { if (!state.marks[ym]) marksAsked.delete(ym); return; }
      const errs = [res.booksError && '読書ハブ', res.filmsError && '映画ハブ'].filter(Boolean);
      const note = errs.length ? `${errs.join('・')}を読めませんでした` : '';
      if (note !== (state.marksNote || '')) { state.marksNote = note; refreshCalendar(); }
      const prev = state.marks[ym];
      state.marks[ym] = { books: new Set(res.books), films: new Set(res.films || []) };
      await db.setMeta(`marks:${ym}`, { books: res.books, films: res.films || [] });
      if (!prev || [...prev.books].join() !== res.books.join() || [...prev.films].join() !== (res.films || []).join()) refreshCalendar();
    })();
  }
  return cached || { books: new Set(), films: new Set() };
}

// 印が届いたら、カレンダーだけ描き直す
function refreshCalendar() {
  const cal = $view.querySelector('.cal');
  if (!cal || !location.hash.startsWith('#day')) return;
  const date = (location.hash.split('/')[1] || '');
  const tmp = document.createElement('div');
  tmp.innerHTML = calendarHtml(isDate(date) ? date : today());
  cal.replaceWith(tmp.firstElementChild);
  bindCalendar(isDate(date) ? date : today());
}

function bindCalendar(date) {
  $view.querySelectorAll('[data-shift]').forEach(b => b.addEventListener('click', () => {
    state.cal = shiftMonth(state.cal[0], state.cal[1], Number(b.dataset.shift));
    state.calMoved = true;
    rerenderDay(date);
  }));
  // 週だけのときは、‹ › で7日ずつ日を送る
  $view.querySelectorAll('[data-wshift]').forEach(b => b.addEventListener('click', () => {
    location.hash = `#day/${shiftDay(date, Number(b.dataset.wshift))}`;
  }));
  const fold = $view.querySelector('[data-calview]');
  if (fold) fold.addEventListener('click', () => {
    state.calWeek = !state.calWeek;
    db.setMeta('calWeek', state.calWeek);
    state.cal = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
    refreshCalendar();
  });
}

function feelingsByDate() {
  const map = new Map();
  for (const e of state.entries) {
    if (!map.has(e.date)) map.set(e.date, []);
    map.get(e.date).push(...splitTags(e.feelings));
  }
  return map;
}

// カレンダー: 日付の下にその日のこころの色のバーと、読了本・映画の点。月の見出しをタップすると、選んだ日の週だけに畳める
function calendarHtml(date) {
  const week = state.calWeek;
  const [y, m] = week ? [Number(date.slice(0, 4)), Number(date.slice(5, 7))] : state.cal;
  const byDate = feelingsByDate();
  const t = today();
  const marksOf = d => monthMarks(Number(d.slice(0, 4)), Number(d.slice(5, 7)));
  const days = week ? weekCells(date) : monthCells(y, m);
  const cells = days.map(d => {
    if (!d) return '<span class="cal__cell cal__cell--empty"></span>';
    const has = byDate.has(d);
    // 日付の下: その日のこころの色のバー(Feelingごとに区切る、最大3色)と、読了本・映画のドット
    const feel = has ? [...new Set(byDate.get(d))].slice(0, 3) : [];
    const bar = has ? `<span class="cal__bar">${feel.length ? feel.map(f => `<i style="${moodStyle(moodOf([f]))}"></i>`).join('') : '<i class="is-plain"></i>'}</span>` : '<span class="cal__bar"></span>';
    const marks = marksOf(d);
    const book = marks.books.has(d), film = marks.films.has(d);
    const dots = `<span class="cal__dots">${book ? '<i class="dot dot--book"></i>' : ''}${film ? '<i class="dot dot--film"></i>' : ''}</span>`;
    const other = week && Number(d.slice(5, 7)) !== m;
    const cls = ['cal__cell', has ? 'has-record' : '', d === date ? 'is-selected' : '', d === t ? 'is-today' : '', d > t ? 'is-future' : '', other ? 'is-other' : ''].filter(Boolean).join(' ');
    const label = [dateLabel(d), has ? '日記あり' : '', book ? '読了本あり' : '', film ? '映画あり' : ''].filter(Boolean).join('・');
    const num = other && d.endsWith('-01') ? `${Number(d.slice(5, 7))}/1` : Number(d.slice(8));
    return `<a class="${cls}" href="#day/${d}" aria-label="${label}"${d === date ? ' aria-current="date"' : ''}><span class="cal__num">${num}</span>${bar}${dots}</a>`;
  }).join('');
  const nav = week
    ? ['<button class="cal__nav" data-wshift="-7" aria-label="前の週">‹</button>', '<button class="cal__nav" data-wshift="7" aria-label="次の週">›</button>']
    : ['<button class="cal__nav" data-shift="-12" aria-label="1年前">«</button><button class="cal__nav" data-shift="-1" aria-label="前の月">‹</button>', '<button class="cal__nav" data-shift="1" aria-label="次の月">›</button><button class="cal__nav" data-shift="12" aria-label="1年後">»</button>'];
  return `
    <div class="card cal${week ? ' cal--week' : ''}">
      <div class="cal__head">
        <span class="cal__navs">${nav[0]}</span>
        <button type="button" class="cal__label" data-calview aria-label="${week ? '月ぜんぶを見る' : 'この週だけにする'}"><small>${y}</small>${m}月<span class="cal__fold" aria-hidden="true">${week ? '⌄' : '⌃'}</span></button>
        <span class="cal__navs">${nav[1]}</span>
      </div>
      <div class="cal__grid cal__week" aria-hidden="true">${[...'日月火水木金土'].map(w => `<span>${w}</span>`).join('')}</div>
      <div class="cal__grid">${cells}</div>
      ${week ? '' : '<div class="cal__legend" aria-hidden="true"><span><i class="dot dot--book"></i>読了</span><span><i class="dot dot--film"></i>映画</span></div>'}
      ${state.marksNote ? `<p class="cal__note">${esc(state.marksNote)}</p>` : ''}
    </div>`;
}

function entryHtml(e) {
  const feel = splitTags(e.feelings);
  // タグをタップすると、そのタグの付いた記録をさがす
  const tagLink = (kind, t) => `#search/${encodeURIComponent(encodeSearch({ [kind]: [t] }))}`;
  const tags = [...feel.map(t => `<a class="tag tag--feel" href="${tagLink('feelings', t)}" style="${moodStyle(moodOf([t]))}">${esc(t)}</a>`), ...splitTags(e.thinkings).map(t => `<a class="tag tag--think" href="${tagLink('thinkings', t)}">${esc(t)}</a>`)].join('');
  // 検索から来たときは、当たった語に印を付ける
  const found = state.found && state.found.hits[e.id];
  return `
    <article class="entry${state.justSaved === e.id ? ' is-new' : ''}${found ? ' is-found' : ''}" data-id="${esc(e.id)}" style="${moodStyle(moodOf(feel))}">
      <div class="entry__rail"><span class="entry__time">${esc(e.time)}</span>${orb(feel, 'orb--rail')}</div>
      <div class="entry__body card paper${feel.length ? ' has-mood' : ''}">
        <p class="entry__text">${found ? markHtml(e.text, found) : esc(e.text)}</p>
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        <div class="note__tools">
          <button class="btn btn--small btn--tinted" data-insight="${esc(e.id)}">知的アドバイス</button>
          <button class="btn btn--small btn--plain" data-edit="${esc(e.id)}">直す</button>
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
  // 書く欄は開いた日だけ。書きかけのある日を開いたら、その続きを開く
  if (state.compose && state.compose.date !== date) state.compose = null;
  const dd = draftDate();
  if (!state.compose && dd === date) openCompose(date, state.draft.id || null);
  const composing = state.compose;
  setTitle('日記', { sub: daySub(date), back: !!state.found });
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
        ${composing ? '' : '<button type="button" class="btn btn--small btn--tinted" id="write-here">＋ この日に書く</button>'}
        ${dd && dd !== date ? `<a class="draft-link small" href="#day/${dd}">${esc(dateLabel(dd).replace(/^\d+年/, ''))}の書きかけがあります ›</a>` : ''}
      </div>
      ${circumplex(feel)}
    </section>
    ${composing && !composing.id ? composerHtml() : ''}
    ${list.length ? `<div class="thread">${list.map(e => composing && composing.id === e.id ? composerHtml() : entryHtml(e)).join('')}</div>` : ''}
    <details class="fold side side--agenda" id="fold-agenda" data-src=""><summary>この日の予定<small>読み込み中</small></summary><div class="fold__body"><div class="card" id="agenda-box" data-day="${date}"><p class="small muted" style="margin:0">読み込み中…</p></div><p class="side__hint">予定や縁の ＋ をタップすると、書いている本文に差し込みます。</p></div></details>
    <details class="fold side side--ensen" id="fold-ensen" data-src="縁泉"><summary>この日の縁<small>読み込み中</small></summary><div class="fold__body"><div class="card" id="ensen-box" data-day="${date}"><p class="small muted" style="margin:0">読み込み中…</p></div></div></details>
    <details class="fold side side--books" id="fold-books" data-src="読書ハブ"><summary>この日に読み終えた本<small>読み込み中</small></summary><div class="fold__body"><div class="card" id="books-box" data-day="${date}"><p class="small muted" style="margin:0">読み込み中…</p></div></div></details>
    <details class="fold side side--films" id="fold-films" data-src="映画ハブ"><summary>この日に観た映画<small>読み込み中</small></summary><div class="fold__body"><div class="card" id="films-box" data-day="${date}"><p class="small muted" style="margin:0">読み込み中…</p></div></div></details>
    <details class="fold side side--news" id="fold-news"><summary>この日のニュース<small>Gemini</small></summary><div class="fold__body"><div class="card" id="news-box"><p class="small muted" style="margin:0">ボタンを押すとGeminiが検索します。送るのは日付だけです。</p></div><div class="actions"><button class="btn btn--tinted" id="news">主要ニュースを取得</button></div></div></details>
    <p class="list-section__footer">${days}日分の記録 ・ <span id="sync-line"></span></p>`;
  watchSync(document.getElementById('sync-line'));
  if (state.found && state.found.focus) {
    const el = $view.querySelector(`.entry[data-id="${CSS.escape(state.found.focus)}"]`);
    state.found.focus = null;
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'auto', block: 'center' }), 60);
  }
  if (state.justSaved) {
    const el = $view.querySelector('.entry.is-new');
    state.justSaved = null;
    if (el) setTimeout(() => el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }), 250);
  }

  bindCalendar(date);
  if (composing) bindComposer(date);
  const here = document.getElementById('write-here');
  if (here) here.addEventListener('click', () => startCompose(date));
  $view.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => startCompose(date, b.dataset.edit)));
  $view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => removeEntry(b.dataset.del)));
  $view.querySelectorAll('[data-insight]').forEach(b => b.addEventListener('click', () => insight(b)));
  document.getElementById('news').addEventListener('click', () => news(date));
  if (state.slide) { slideIn(state.slide, '.day-head, .thread, .side'); state.slide = 0; }
  loadAgenda(date);
  loadEnsen(date);
  loadBooks(date);
  loadFilms(date);
}

async function side(kind, date, extra = {}) {
  const key = `${kind}:${date}:${JSON.stringify(extra)}`;
  if (!state.side[key]) state.side[key] = sync.ask(kind, { date, ...extra }).catch(e => { delete state.side[key]; return { ok: false, error: e.message }; });
  return state.side[key];
}

async function loadEnsen(date) {
  // 本・映画の欄と同じ問い合わせを待つ(side は同じ日の問い合わせを使い回すので、ハブへは1回ずつ)
  const [res, books, films] = await Promise.all([side('ensen', date), side('books', date), side('films', date)]);
  const box = document.getElementById('ensen-box');
  if (!box || box.dataset.day !== date) return; // 返事が届く前に別の日へ移っていたら捨てる
  if (!res.ok) { box.innerHTML = `<p class="small muted" style="margin:0">縁泉を読めませんでした: ${esc(res.error)}</p>`; settle('ensen', -1); return; }
  // 縁泉が追記した本・映画は、本・映画の欄が読めたときはそちらに任せる(読めなかったときは残す)
  const events = ensenEventsShown(res.events, { books: !!(books.ok && Array.isArray(books.books)), films: !!(films.ok && Array.isArray(films.films)) });
  settle('ensen', events.length + (res.traces || []).length + (res.homeMoves || []).length);
  const parts = events.map(ev => {
    const where = ev.place && ev.place !== ev.name ? ` <span class="muted small">・${esc(ev.place)}</span>` : '';
    const media = ev.media ? ` <a href="${esc(ev.media)}" target="_blank" rel="noopener" aria-label="写真">📷</a>` : '';
    const line = [ev.time, `${ev.name || ''}${ev.verb || ''}`].filter(Boolean).join(' ');
    return `<div class="ev"><div class="ev__main"><span class="ev__time">${esc(ev.time)}</span> <span class="muted small">${esc(ev.type)}</span> <b>${esc(ev.name)}</b> <span class="ev__verb">${esc(ev.verb)}</span>${where}${media}${ev.note ? `<div class="small muted">${esc(ev.note)}</div>` : ''}</div><button type="button" class="ev__add" data-q="${esc(line)}" aria-label="${esc(line)} を本文に差し込む">＋</button></div>`;
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
  box.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => {
    const q = b.dataset.q;
    quoteLine(date, q);
    const again = document.querySelector(`#ensen-box [data-q="${CSS.escape(q)}"]`);
    if (again) again.classList.add('is-added');
  }));
}

async function loadBooks(date) {
  const res = await side('books', date);
  const box = document.getElementById('books-box');
  if (!box || box.dataset.day !== date) return; // 返事が届く前に別の日へ移っていたら捨てる
  if (!res.ok) { box.innerHTML = `<p class="small muted" style="margin:0">読書ハブを読めませんでした: ${esc(res.error)}</p>`; settle('books', -1); return; }
  settle('books', res.books.length);
  box.innerHTML = res.books.length ? res.books.map(b => `
    <a class="book" href="${esc(b.url)}" target="_blank" rel="noopener">
      <span class="cover cover--sm">${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
      <span class="book__text"><b>${esc(b.title)}</b> <span class="muted small">↗</span><span class="small muted" style="display:block">${esc(b.author)}${b.category ? ` ・${esc(b.category)}` : ''}</span>${b.note ? `<span class="small book__note">${esc(b.note)}</span>` : ''}</span>
    </a>`).join('') : '<p class="small muted" style="margin:0">この日に読み終えた本はありません。</p>';
}

async function loadFilms(date) {
  const res = await side('films', date);
  const box = document.getElementById('films-box');
  if (!box || box.dataset.day !== date) return; // 返事が届く前に別の日へ移っていたら捨てる
  if (res.ok && !Array.isArray(res.films)) { res.ok = false; res.error = '日記ハブを新しい版で出し直すと表示されます'; }
  if (!res.ok) { box.innerHTML = `<p class="small muted" style="margin:0">映画ハブを読めませんでした: ${esc(res.error)}</p>`; settle('films', -1); return; }
  settle('films', res.films.length);
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

// ---------- さがす(過去の日記の検索) ----------
// 記録はハブから全期間が端末に届いているので、端末の中だけで探す(圏外でも動き、何も送らない)
const PAGE = 60;
const srch = { q: '', feelings: [], thinkings: [], order: 'new', limit: PAGE, scroll: 0, results: [] };

// 記録に実際に使われたタグ(シートに無い古いタグも含む)
function usedTags(kind) {
  const c = tagCounts(kind);
  return orderedTags(kind, tagChoices(state.tags[kind].filter(t => c[t]), new Set(Object.keys(c))));
}

function searchChips(kind) {
  const sel = srch[kind];
  return usedTags(kind).map(n => `<button type="button" class="kind kind--${kind}${sel.includes(n) ? ' is-active' : ''}" data-skind="${kind}" data-stag="${esc(n)}" aria-pressed="${sel.includes(n)}"${kind === 'feelings' ? ` style="${moodStyle(moodOf([n]))}"` : ''}>${esc(n)}</button>`).join('')
    || '<p class="small muted" style="margin:0">まだタグの付いた記録がありません。</p>';
}

// 時の帯: その言葉が、いつの自分に現れていたか。年ごとに12か月、濃さ=件数、色=その月のこころの平均
function timelineHtml(results) {
  const { years, cells } = timeline(results);
  if (!years.length) return '';
  const max = Math.max(...Object.values(cells).map(c => c.n));
  const rows = years.map(y => `<div class="tl__row"><span class="tl__year">${y}</span>${Array.from({ length: 12 }, (_, i) => {
    const ym = `${y}-${String(i + 1).padStart(2, '0')}`;
    const c = cells[ym];
    if (!c) return '<span class="tl__cell"></span>';
    const m = moodOf(c.feelings);
    const k = (0.35 + 0.65 * c.n / max).toFixed(2);
    return `<button type="button" class="tl__cell is-hit${m ? '' : ' is-plain'}" data-ym="${ym}" style="${moodStyle(m)};--k:${k}" aria-label="${y}年${i + 1}月 ${c.n}件">${c.n > 1 ? `<small>${c.n}</small>` : ''}</button>`;
  }).join('')}</div>`).join('');
  return `<div class="card tl" aria-label="当たった記録の時期">
    <div class="tl__row tl__months" aria-hidden="true"><span class="tl__year"></span>${Array.from({ length: 12 }, (_, i) => `<span>${i + 1}</span>`).join('')}</div>
    ${rows}</div>`;
}

function resultHtml(r, prevDate) {
  const e = r.e;
  const feel = splitTags(e.feelings);
  const tags = [...feel.map(t => `<span class="tag tag--feel${r.tagHits.has(t) ? ' is-hit' : ''}" style="${moodStyle(moodOf([t]))}">${esc(t)}</span>`), ...splitTags(e.thinkings).map(t => `<span class="tag tag--think${r.tagHits.has(t) ? ' is-hit' : ''}">${esc(t)}</span>`)].join('');
  const head = e.date !== prevDate ? `<h3 class="hit__date" data-ym="${e.date.slice(0, 7)}">${dateLabel(e.date)}</h3>` : '';
  return `${head}<a class="hit paper${feel.length ? ' has-mood' : ''}" href="#day/${e.date}" data-hit="${esc(e.id)}" style="${moodStyle(moodOf(feel))}">
    <span class="hit__rail"><span class="entry__time">${esc(e.time)}</span>${orb(feel, 'orb--rail')}</span>
    <span class="hit__body"><span class="hit__text">${snippetHtml(e.text, r.hits)}</span>${tags ? `<span class="tags">${tags}</span>` : ''}</span>
  </a>`;
}

function updateSearch({ keepScroll = false } = {}) {
  const box = document.getElementById('search-results');
  if (!box) return;
  const res = srch.results = searchEntries(state.entries, srch);
  history.replaceState(null, '', `#search/${encodeURIComponent(encodeSearch(srch))}`);
  for (const b of $view.querySelectorAll('[data-stag]')) {
    const on = srch[b.dataset.skind].includes(b.dataset.stag);
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on);
  }
  document.getElementById('cnt-sf').textContent = srch.feelings.length ? ` ${srch.feelings.length}` : '';
  document.getElementById('cnt-st').textContent = srch.thinkings.length ? ` ${srch.thinkings.length}` : '';
  const active = srch.q.trim() || srch.feelings.length || srch.thinkings.length;
  if (!active) {
    const days = new Set(state.entries.map(e => e.date)).size;
    const first = state.entries.reduce((m, e) => (!m || e.date < m ? e.date : m), '');
    box.innerHTML = `<p class="list-section__footer">${state.entries.length}件の記録(${days}日分${first ? `、${dateLabel(first)}から` : ''})から探します。<br>
      空白で区切ると「すべて含む」、<b>-語</b> でその語を含まないもの、<b>2024</b> や <b>2024年5月</b> でその時期に絞れます。ひらがなとカタカナは区別しません。記録はこの端末の中で探すので、圏外でも使えます。</p>`;
    return;
  }
  if (!res.length) { box.innerHTML = '<p class="list-section__footer">見つかりませんでした。語を短くするか、絞り込みを外してみてください。</p>'; return; }
  const days = new Set(res.map(r => r.e.date)).size;
  const co = coFeelings(res, srch.feelings);
  let prev = '';
  const list = res.slice(0, srch.limit).map(r => { const h = resultHtml(r, prev); prev = r.e.date; return h; }).join('');
  box.innerHTML = `
    <div class="search-sum"><span><b>${res.length}</b>件 ・ ${days}日</span>
      <div class="segmented" role="radiogroup" aria-label="並べ方">${[['new', '新しい順'], ['old', '古い順']].map(([k, l]) => `<button type="button" class="segmented__item${srch.order === k ? ' is-active' : ''}" role="radio" aria-checked="${srch.order === k}" data-sorder="${k}">${l}</button>`).join('')}</div></div>
    ${timelineHtml(res)}
    ${co.length ? `<div class="co"><span class="small muted">いっしょにあったこころ</span>${co.map(([f, n]) => `<button type="button" class="tag tag--feel co__tag" data-cof="${esc(f)}" style="${moodStyle(moodOf([f]))}">${esc(f)} <small>${n}</small></button>`).join('')}</div>` : ''}
    <div class="hits">${list}</div>
    ${res.length > srch.limit ? `<div class="actions"><button class="btn btn--tinted" id="s-more">さらに表示(残り${res.length - srch.limit}件)</button></div>` : ''}`;
  box.querySelectorAll('[data-sorder]').forEach(b => b.addEventListener('click', () => { srch.order = b.dataset.sorder; srch.limit = PAGE; updateSearch(); }));
  box.querySelectorAll('[data-cof]').forEach(b => b.addEventListener('click', () => { srch.feelings = [...srch.feelings, b.dataset.cof]; srch.limit = PAGE; updateSearch(); }));
  const more = document.getElementById('s-more');
  if (more) more.addEventListener('click', () => { srch.limit += PAGE * 2; updateSearch({ keepScroll: true }); });
  box.querySelectorAll('.tl__cell[data-ym]').forEach(b => b.addEventListener('click', () => {
    const ym = b.dataset.ym;
    const idx = srch.results.findIndex(r => r.e.date.startsWith(ym));
    if (idx >= srch.limit) { srch.limit = idx + PAGE; updateSearch(); }
    const h = box.querySelector(`.hit__date[data-ym="${ym}"]`);
    if (h) h.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));
  // 当たった記録を開くと、その日のページで当たった語に印が付き、戻るでこの検索に帰れる
  box.querySelectorAll('[data-hit]').forEach(a => a.addEventListener('click', () => {
    const hits = {};
    for (const r of srch.results) hits[r.e.id] = r.hits;
    state.found = { hits, focus: a.dataset.hit };
    srch.scroll = scrollY;
    srch.restore = true;
    state.calMoved = false;
  }));
  if (!keepScroll && document.activeElement && document.activeElement.id !== 's-q') scrollTo(0, 0);
}

function renderSearch(arg) {
  setTab('search');
  setTitle('さがす');
  const back = srch.restore;
  srch.restore = false;
  if (arg) Object.assign(srch, decodeSearch(arg)); // タブから開いたときは前の検索のまま
  if (!back) srch.limit = PAGE;
  $view.innerHTML = `
    <form class="search search--page" role="search" id="s-form">
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="s-q" type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ことば、タグ、2024年5月 など" aria-label="日記をさがす" value="${esc(srch.q)}">
      <button type="button" class="search__clear" id="s-clear" aria-label="消す"${srch.q ? '' : ' hidden'}>×</button>
    </form>
    <details class="fold" id="fold-sf"${srch.feelings.length ? ' open' : ''}><summary>Feeling で絞る<small id="cnt-sf"></small></summary><div class="fold__body"><div class="kinds" style="padding-top:0">${searchChips('feelings')}</div></div></details>
    <details class="fold" id="fold-st"${srch.thinkings.length ? ' open' : ''}><summary>Thinking で絞る<small id="cnt-st"></small></summary><div class="fold__body"><div class="kinds" style="padding-top:0">${searchChips('thinkings')}</div></div></details>
    <div id="search-results"></div>`;
  const input = document.getElementById('s-q');
  const clear = document.getElementById('s-clear');
  let t = null;
  input.addEventListener('input', () => {
    clear.hidden = !input.value;
    clearTimeout(t);
    t = setTimeout(() => { srch.q = input.value; srch.limit = PAGE; updateSearch(); }, 160);
  });
  document.getElementById('s-form').addEventListener('submit', e => { e.preventDefault(); input.blur(); srch.q = input.value; updateSearch(); });
  clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; srch.q = ''; updateSearch(); input.focus(); });
  $view.querySelectorAll('[data-stag]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.skind, n = b.dataset.stag;
    srch[k] = srch[k].includes(n) ? srch[k].filter(x => x !== n) : [...srch[k], n];
    srch.limit = PAGE;
    updateSearch();
  }));
  updateSearch({ keepScroll: true });
  if (back) scrollTo(0, srch.scroll);
  else if (!srch.q && !srch.feelings.length && !srch.thinkings.length) input.focus({ preventScroll: true });
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

// ---------- 設定: 予定を読むGoogleカレンダー ----------
function calendarRows(list) {
  const chosen = new Set(state.calIds);
  const none = !chosen.size;
  return list.map(c => {
    const on = none ? c.shown : chosen.has(c.id);
    const color = /^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : 'var(--color-accent)';
    return `<label class="gcal__row"><input type="checkbox" data-cal="${esc(c.id)}"${on ? ' checked' : ''}><span class="gcal__sw" style="background:${color}"></span><span class="gcal__name">${esc(c.name)}${c.primary ? ' <small class="muted">メイン</small>' : ''}</span></label>`;
  }).join('') || '<p class="small muted" style="margin:0">カレンダーが見つかりませんでした。</p>';
}

async function setCalIds(ids) {
  state.calIds = ids;
  await db.setMeta('calendarIds', ids);
  for (const k of Object.keys(state.side)) if (k.startsWith('calendar:')) delete state.side[k];
  const sum = document.getElementById('gcal-sum');
  if (sum) sum.textContent = ids.length ? `${ids.length}個を表示` : 'Googleで表示中のもの';
  const clear = document.getElementById('gcal-clear');
  if (clear) clear.disabled = !ids.length;
}

async function bindCalendars() {
  const box = document.getElementById('gcal-box');
  const draw = list => {
    box.innerHTML = calendarRows(list);
    box.querySelectorAll('[data-cal]').forEach(cb => cb.addEventListener('change', () => {
      // はじめて選ぶときは、いまのチェック(Googleで表示中のもの)から始める
      setCalIds([...box.querySelectorAll('[data-cal]:checked')].map(x => x.dataset.cal));
    }));
  };
  document.getElementById('gcal-clear').addEventListener('click', async () => {
    await setCalIds([]);
    draw((await db.getMeta('calendarList')) || []);
  });
  const cached = await db.getMeta('calendarList');
  if (cached) draw(cached);
  if (!sync.enabled()) return;
  const res = await sync.ask('calendars').catch(e => ({ ok: false, error: e.message }));
  if (!document.body.contains(box)) return;
  if (res.ok && !Array.isArray(res.calendars)) { res.ok = false; res.error = '日記ハブがまだ古い版です'; }
  if (!res.ok) {
    if (!cached) box.innerHTML = `<p class="small muted" style="margin:0">一覧を読めませんでした: ${esc(res.error)}${/古い版|unknown action/.test(res.error || '') ? '(日記ハブを新しい版で出し直すと選べます)' : ''}</p>`;
    return;
  }
  await db.setMeta('calendarList', res.calendars);
  draw(res.calendars);
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
    <details class="fold" id="gcal-fold"><summary>Googleカレンダー<small id="gcal-sum">${state.calIds.length ? `${state.calIds.length}個を表示` : 'Googleで表示中のもの'}</small></summary><div class="fold__body">
      <div class="card gcal" id="gcal-box"><p class="small muted" style="margin:0">${sync.enabled() ? '読み込み中…' : '日記ハブにつなぐと選べます。'}</p></div>
      <div class="actions"><button class="btn btn--plain" id="gcal-clear"${state.calIds.length ? '' : ' disabled'}>Googleでの表示どおりに戻す</button></div>
      <p class="list-section__footer">選んだカレンダーの予定を、日記の「この日の予定」に出します。選ぶのは、この端末に覚えます。読むだけで、予定を書き換えることはありません。</p>
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
  bindCalendars();
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
// 前の「記録」タブへのリンク(#write, #write/日付, #write/記録id)は、日記タブの書く欄に読み替える
function legacyWrite(a) {
  const e = a && !isDate(a) ? state.entries.find(x => x.id === a) : null;
  const date = e ? e.date : isDate(a) ? a : today();
  openCompose(date, e ? e.id : null);
  location.replace(`#day/${date}`);
}

async function route() {
  const [name, arg] = location.hash.replace(/^#/, '').split('/');
  const a = arg ? decodeURIComponent(arg) : '';
  if (name !== 'day') window.scrollTo(0, 0);
  if (name !== 'day') state.found = null;
  if (name !== 'day' && name !== 'search') srch.restore = false;
  watchSync(null);
  switch (name) {
    case 'day': return renderDay(a);
    case 'search': return renderSearch(a);
    case 'settings': return renderSettings();
    case 'write': return legacyWrite(a);
    default: return renderDay(today());
  }
}

document.getElementById('back').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#day'));
addEventListener('hashchange', () => {
  // 日記タブ内で日付を変えたときは、カレンダーの位置を保つ
  const keep = location.hash.startsWith('#day/') && !(state.found && state.found.focus);
  const y = scrollY;
  route().then(() => { if (keep) scrollTo(0, y); });
});

// 日記タブ: 左右のフリックで日を送る。カレンダーの上なら月を送る
let touch = null;
$view.addEventListener('touchstart', e => {
  const t = e.touches[0];
  const ok = e.touches.length === 1 && location.hash.startsWith('#day') && !e.target.closest('input, textarea, select, .traces, [data-noswipe]');
  touch = ok ? { x: t.clientX, y: t.clientY, at: Date.now(), cal: !!e.target.closest('.cal') } : null;
}, { passive: true });
$view.addEventListener('touchend', e => {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dir = swipeDir(t.clientX - touch.x, t.clientY - touch.y, Date.now() - touch.at);
  const onCal = touch.cal;
  touch = null;
  if (!dir) return;
  const cur = (location.hash.split('/')[1] || '');
  const date = isDate(cur) ? cur : today();
  if (onCal && state.calWeek) { location.replace(`#day/${shiftDay(date, 7 * dir)}`); return; }
  if (onCal) {
    state.cal = shiftMonth(state.cal[0], state.cal[1], dir);
    state.calMoved = true;
    const y = scrollY;
    renderDay(date).then(() => { scrollTo(0, y); slideIn(dir, '.cal'); });
    return;
  }
  state.slide = dir;
  location.replace(`#day/${shiftDay(date, dir)}`);
}, { passive: true });
$view.addEventListener('touchcancel', () => { touch = null; }, { passive: true });

// 送った向きから、ふわっと入ってくる
function slideIn(dir, sel) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $view.querySelectorAll(sel).forEach(el => {
    el.classList.remove('slide-next', 'slide-prev');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'slide-next' : 'slide-prev');
  });
}

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
  // 開いたときは今日のページで、書く欄を開いておく(前の「記録」タブの代わり)。書きかけがあればその日
  if (!location.hash || location.hash === '#day' || location.hash === `#day/${today()}`) {
    if (!draftDate()) openCompose(today());
  }
  route();
  sync.schedule(300);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.schedule(300); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

window.__app = { state, form };
