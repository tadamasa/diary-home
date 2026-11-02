/**
 * 日記ハブ: ホーム画面の日記アプリ(https://tadamasa.github.io/diary-home/)と、
 * いまの「日記の記録」スプレッドシート(CoreData)をつなぐ受け口。
 *
 * 使い方は hub/README.md を参照。
 *  1. script.google.com で新しいプロジェクトを作り、このファイルを貼る(スプレッドシートに付けなくてよい)
 *  2. setup を一度実行(合言葉が実行ログに出る)
 *  3. デプロイ → 新しいデプロイ → ウェブアプリ(実行ユーザー: 自分、アクセス: 全員)
 *  4. 出たURLと合言葉を、日記アプリの設定に入れる
 *
 * CoreData は、これまでの日記GAS(元版・v2)もそのまま読み書きする。だからこのハブは
 *  - CoreData の A〜E 列(Date, Time, Text, Feelings, Thinkings)の形を変えない
 *  - 行を挿入・削除しない(GAS側は行番号で編集・削除するため)。アプリでの削除は A〜E を空にするだけ
 *  - 足すのは F 列「Id」と、同期の台帳シート「_同期台帳」(id, rev, mtime, deleted, hash)だけ
 * GAS側や手で表を直した分は、同期のたびに hash を比べて見つけ、新しい rev を振ってアプリへ流す。
 */

const TIMEZONE = 'Asia/Tokyo';
const DIARY_SHEET_ID_DEFAULT = '1yVC3q2dm4-LxrAg_lRDk8G3qqU-WNQnI5LznFPgxKp8';
const CORE = 'CoreData';
const LEDGER = '_同期台帳';
const LEDGER_COLS = ['id', 'rev', 'mtime', 'deleted', 'hash'];
const ID_COL = 6; // F
const PAGE = 400; // 1回の応答で返す最大件数

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  const ss = db_();
  ledger_(ss);
  const core = ss.getSheetByName(CORE);
  if (!core) throw new Error('CoreData シートが見つかりません');
  if (!core.getRange(1, ID_COL).getValue()) core.getRange(1, ID_COL).setValue('Id');
  Logger.log('合言葉: ' + props.getProperty('TOKEN'));
}

function doGet() {
  return json_({ ok: true, app: 'diary-hub' });
}

// 受け取る: { token, action?, since, entries: [{id, mtime, deleted, data}], newTags: [{category, name}] }
// 返す:     { ok, rev, more, entries: [{id, mtime, deleted, data}], tags, prompts }
// action が 'ensen' / 'books' / 'films' / 'calendar' なら { date } を受けて、その日の縁泉・読了本・映画・予定を返す(読み取りのみ)
// action が 'calendars' なら、選べるカレンダーの一覧を返す
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || req.token !== token) return json_({ ok: false, error: 'unauthorized' });
  if (req.action === 'ensen') return json_(getEnsenForDate(String(req.date || '')));
  if (req.action === 'books') return json_(getBooksForDate(String(req.date || '')));
  if (req.action === 'calendar') return json_(getCalendarForDate(String(req.date || ''), req.ids));
  if (req.action === 'calendars') return json_(getCalendars());
  if (req.action === 'films') return json_(getFilmsForDate(String(req.date || '')));
  if (req.action === 'month') return json_(getMonthMarks(String(req.month || '')));
  if (req.action) return json_({ ok: false, error: 'unknown action' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return json_(sync_(req));
  } finally {
    lock.releaseLock();
  }
}

function sync_(req) {
  const props = PropertiesService.getScriptProperties();
  const ss = db_();
  const since = Number(req.since || 0);
  const st = reconcile_(ss, Number(props.getProperty('REV') || 0));
  const core = st.core;

  for (const item of req.entries || []) {
    if (!item || !item.id) continue;
    const id = String(item.id);
    const li = st.lidx[id];
    if (li !== undefined && Number(st.ledger[li][2]) > Number(item.mtime || 0)) continue; // 表のほうが新しい
    st.rev += 1;
    const ri = st.byId[id];
    let hash = '';
    if (item.deleted || !item.data) {
      if (ri !== undefined) core.getRange(ri + 2, 1, 1, 5).setValues([['', '', '', '', '']]);
    } else {
      const c = content_(item.data);
      const vals = cells_(c);
      if (ri !== undefined) {
        core.getRange(ri + 2, 1, 1, 5).setValues([vals]);
      } else {
        core.appendRow(vals.concat([id]));
        st.byId[id] = st.rows.length;
        st.rows.push(['', '', '', '', '', id]);
      }
      const r = st.rows[st.byId[id]];
      r[0] = c.date; r[1] = c.time; r[2] = c.text; r[3] = c.feelings; r[4] = c.thinkings;
      hash = hash_(c);
    }
    const row = [id, String(st.rev), String(Number(item.mtime || Date.now())), String(!hash), hash];
    if (li === undefined) { st.lidx[id] = st.ledger.length; st.ledger.push(row); } else st.ledger[li] = row;
    st.dirty = true;
  }

  addTags_(ss, req.newTags || []);
  if (st.dirty) writeLedger_(st.lsh, st.ledger);
  props.setProperty('REV', String(st.rev));

  // since より新しいものを古い順に PAGE 件まで返す。残りがあれば more を立て、返した最後の rev を次の起点にする
  const fresh = st.ledger.filter(r => Number(r[1]) > since).sort((x, y) => Number(x[1]) - Number(y[1]));
  const page = fresh.slice(0, PAGE);
  const out = {
    ok: true,
    more: fresh.length > PAGE,
    rev: fresh.length > PAGE ? Number(page[page.length - 1][1]) : st.rev,
    entries: [],
    tags: tags_(ss),
    prompts: prompts_(ss),
  };
  for (const r of page) {
    const id = String(r[0]);
    const deleted = String(r[3]) === 'true';
    const ri = st.byId[id];
    if (deleted || ri === undefined) { out.entries.push({ id, mtime: Number(r[2]), deleted: true }); continue; }
    const c = norm_(st.rows[ri]);
    out.entries.push({
      id, mtime: Number(r[2]), deleted: false,
      data: { id, date: c.date, time: c.time, text: c.text, feelings: split_(c.feelings), thinkings: split_(c.thinkings) },
    });
  }
  return out;
}

/**
 * CoreData と台帳を突き合わせる。
 *  - Id のない行(GAS側で書いた行)に Id を振る
 *  - 中身の hash が台帳と違う行(GAS側で直した行)に新しい rev を振る
 *  - 台帳にあるのに表から消えた行・空にされた行は削除として rev を振る
 */
function reconcile_(ss, rev) {
  const core = ss.getSheetByName(CORE);
  if (!core) throw new Error('CoreData シートが見つかりません');
  const last = core.getLastRow();
  const rows = last > 1 ? core.getRange(2, 1, last - 1, ID_COL).getValues() : [];
  const lsh = ledger_(ss);
  const ledger = lsh.getLastRow() > 1 ? lsh.getRange(2, 1, lsh.getLastRow() - 1, LEDGER_COLS.length).getValues().map(r => r.map(String)) : [];
  const lidx = {};
  ledger.forEach((r, i) => { if (r[0]) lidx[r[0]] = i; });
  const now = String(Date.now());
  const byId = {};
  let idsChanged = false;
  let dirty = false;
  const bump = (id, deleted, hash) => {
    rev += 1;
    const row = [id, String(rev), now, String(deleted), hash];
    if (lidx[id] === undefined) { lidx[id] = ledger.length; ledger.push(row); } else ledger[lidx[id]] = row;
    dirty = true;
  };

  rows.forEach((r, i) => {
    const c = norm_(r);
    let id = String(r[ID_COL - 1] || '').trim();
    if (id && byId[id] !== undefined) id = ''; // 行をコピーして Id まで重なったときは別の記録として扱う
    const empty = !c.date && !c.text;
    if (empty) {
      if (!id) return;
      byId[id] = i;
      const li = lidx[id];
      if (li !== undefined && ledger[li][3] !== 'true') bump(id, true, '');
      return;
    }
    if (!id) { id = newId_(); r[ID_COL - 1] = id; idsChanged = true; }
    byId[id] = i;
    const h = hash_(c);
    const li = lidx[id];
    if (li === undefined || ledger[li][4] !== h || ledger[li][3] === 'true') bump(id, false, h);
  });
  ledger.forEach(r => { if (r[0] && r[3] !== 'true' && byId[r[0]] === undefined) bump(r[0], true, ''); });

  if (idsChanged) {
    const range = core.getRange(2, ID_COL, rows.length, 1);
    range.setNumberFormat('@');
    range.setValues(rows.map(r => [String(r[ID_COL - 1] || '')]));
    if (!core.getRange(1, ID_COL).getValue()) core.getRange(1, ID_COL).setValue('Id');
  }
  return { core, rows, byId, lsh, ledger, lidx, rev, dirty };
}

// 表のセル → 比べられる文字列。古い行には日付・時刻が Date のまま入っていることがある
function norm_(r) {
  const d = v => v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd') : String(v == null ? '' : v).trim();
  const t = v => v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'HH:mm') : String(v == null ? '' : v).trim();
  return { date: d(r[0]), time: t(r[1]), text: String(r[2] == null ? '' : r[2]), feelings: String(r[3] == null ? '' : r[3]).trim(), thinkings: String(r[4] == null ? '' : r[4]).trim() };
}

// アプリのデータ → 表と同じ形の文字列(タグは「,」区切り。GAS日記と同じ)
function content_(d) {
  const join = a => (Array.isArray(a) ? a : split_(a)).map(x => String(x).trim()).filter(x => x).join(',');
  return { date: String(d.date || '').slice(0, 10), time: String(d.time || '').slice(0, 5), text: String(d.text || ''), feelings: join(d.feelings), thinkings: join(d.thinkings) };
}

// GAS日記と同じく日付・時刻は先頭に ' を付けて文字のまま入れる。= などで始まる本文も式にならないようにする
function cells_(c) {
  const safe = s => /^[=+\-@]/.test(s) ? "'" + s : s;
  return ["'" + c.date, "'" + c.time, safe(c.text), safe(c.feelings), safe(c.thinkings)];
}

function split_(s) {
  return String(s || '').split(/[,、]/).map(x => x.trim()).filter(x => x);
}

// FNV-1a(32bit)。改ざん検知ではなく「変わったか」を見るだけなので軽いもので足りる
function hash_(c) {
  const s = [c.date, c.time, c.text, c.feelings, c.thinkings].join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

function newId_() {
  return 's' + Utilities.getUuid().replace(/-/g, '').slice(0, 15);
}

function ledger_(ss) {
  let sh = ss.getSheetByName(LEDGER);
  if (!sh) {
    sh = ss.insertSheet(LEDGER);
    sh.getRange(1, 1, sh.getMaxRows(), LEDGER_COLS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, LEDGER_COLS.length).setValues([LEDGER_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function writeLedger_(sh, ledger) {
  if (!ledger.length) return;
  const need = ledger.length + 1 - sh.getMaxRows();
  if (need > 0) { sh.insertRowsAfter(sh.getMaxRows(), need); sh.getRange(1, 1, sh.getMaxRows(), LEDGER_COLS.length).setNumberFormat('@'); }
  sh.getRange(2, 1, ledger.length, LEDGER_COLS.length).setValues(ledger);
}

function tags_(ss) {
  const sh = ss.getSheetByName('タグ管理');
  const tags = { feelings: [], thinkings: [] };
  if (!sh) return tags;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const c = String(data[i][0]).trim().toLowerCase();
    const n = String(data[i][1]).trim();
    if (!n) continue;
    if (c === 'feeling' && tags.feelings.indexOf(n) === -1) tags.feelings.push(n);
    if (c === 'thinking' && tags.thinkings.indexOf(n) === -1) tags.thinkings.push(n);
  }
  return tags;
}

// アプリで足したタグ。すでにあるものは足さない
function addTags_(ss, list) {
  if (!list.length) return;
  const sh = ss.getSheetByName('タグ管理');
  if (!sh) return;
  const have = tags_(ss);
  for (const t of list) {
    const cat = String(t.category || '').toLowerCase() === 'feeling' ? 'Feeling' : 'Thinking';
    const name = String(t.name || '').trim();
    const bucket = cat === 'Feeling' ? have.feelings : have.thinkings;
    if (!name || bucket.indexOf(name) !== -1) continue;
    sh.appendRow([cat, name]);
    bucket.push(name);
  }
}

// 「プロンプト管理」シート(項目名, プロンプト内容)。Gemini はアプリから呼ぶので、指示文だけ渡す
function prompts_(ss) {
  const sh = ss.getSheetByName('プロンプト管理');
  const out = {};
  if (!sh) return out;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const k = String(data[i][0]).trim();
    if (k) out[k] = String(data[i][1] || '');
  }
  return out;
}

function db_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DIARY_SHEET_ID_DEFAULT;
  return SpreadsheetApp.openById(id);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ========== Googleカレンダー：読み取り専用 ==========
// その日の予定を集める。どのカレンダーから読むかは、次の順で決める。
//  1. アプリの設定で選んだもの(req.ids、端末に保存)
//  2. スクリプト プロパティ CALENDAR_IDS(カンマ区切り)
//  3. Googleカレンダーで表示中(チェックの入っている)もの
function getCalendarForDate(dateStr, reqIds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { ok: false, error: 'bad date' };
  try {
    let ids = Array.isArray(reqIds) ? reqIds.map(function (x) { return String(x).trim(); }).filter(String) : [];
    if (!ids.length) ids = String(prop_('CALENDAR_IDS', '')).split(',').map(function (x) { return x.trim(); }).filter(String);
    const cals = ids.length
      ? ids.map(function (id) { return CalendarApp.getCalendarById(id); }).filter(Boolean)
      : CalendarApp.getAllCalendars().filter(function (c) { return !c.isHidden() && c.isSelected(); });
    const p = dateStr.split('-').map(Number);
    const day = new Date(p[0], p[1] - 1, p[2]);
    const events = [];
    cals.forEach(function (cal) {
      cal.getEventsForDay(day).forEach(function (ev) {
        const allDay = ev.isAllDayEvent();
        events.push({
          title: ev.getTitle() || '(無題)',
          start: allDay ? '' : Utilities.formatDate(ev.getStartTime(), TIMEZONE, 'HH:mm'),
          end: allDay ? '' : Utilities.formatDate(ev.getEndTime(), TIMEZONE, 'HH:mm'),
          allDay: allDay,
          location: ev.getLocation() || '',
          calendar: cal.getName(),
          color: cal.getColor(),
        });
      });
    });
    events.sort(function (a, b) { return (a.allDay ? '' : a.start) < (b.allDay ? '' : b.start) ? -1 : 1; });
    return { ok: true, events: events, chosen: ids.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 自分が見られるカレンダーの一覧(設定で選ぶため)。主カレンダー → Googleで表示中 → 名前の順
function getCalendars() {
  try {
    const list = CalendarApp.getAllCalendars().map(function (c) {
      return {
        id: c.getId(),
        name: c.getName(),
        color: c.getColor(),
        shown: !c.isHidden() && c.isSelected(),
        primary: typeof c.isMyPrimaryCalendar === 'function' ? !!c.isMyPrimaryCalendar() : false,
      };
    });
    list.sort(function (a, b) {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      if (a.shown !== b.shown) return a.shown ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return { ok: true, calendars: list };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ========== その日のまわり(縁泉・読了本・観た映画・月の印): 読み取りのみ ==========
// 読み方はライブラリ DayReaders(lib/day-readers/DayReaders.gs)にまとめた。縁泉ハブ・日記v2 も同じものを使う。
// ここではスクリプト プロパティからシートIDとアプリURLを決めて渡すだけ。
// ライブラリは「ライブラリ +」で版を固定して追加する(識別子 DayReaders)。手順は lib/day-readers/README.md。
const ENSEN_SHEET_ID_DEFAULT = '1vKPwd3kM4RdD19PEWaCG1R6OuVJGxSjj2njlan6UBFA';
const ENSEN_UI_URL_DEFAULT = 'https://script.google.com/macros/s/AKfycbzosCrpBeAfjQDSSxaXo9vFhxgcYTPRKyTz4m9VHMZwvWWMp9wUUWTund4G2PBsghQ/exec';
const BOOKS_SHEET_ID_DEFAULT = '1WEsS95CKH7JPFuGf7BYzlTV-d6FyTVg0OCOymKHqsZg';
const READING_APP_URL_DEFAULT = 'https://tadamasa.github.io/reading-memo/';
const MOVIES_SHEET_ID_DEFAULT = '156oktIUuxKOcFZn0QYrx6ncY3AFiY-7DjgAIYbiRCm4';
const MOVIE_APP_URL_DEFAULT = 'https://tadamasa.github.io/movie-memo/';

function prop_(k, d) { return PropertiesService.getScriptProperties().getProperty(k) || d; }

// ライブラリを追加する前にこの版を貼っても、同期は動き、その日のまわりだけが理由つきで空になる
function readers_() {
  if (typeof DayReaders === 'undefined') throw new Error('ライブラリ DayReaders が追加されていません(lib/day-readers/README.md)');
  return DayReaders;
}

function getEnsenForDate(dateStr) {
  const uiUrl = prop_('ENSEN_UI_URL', ENSEN_UI_URL_DEFAULT);
  try {
    const res = readers_().ensenForDate(prop_('ENSEN_SHEET_ID', ENSEN_SHEET_ID_DEFAULT), dateStr);
    res.uiUrl = uiUrl;
    return res;
  } catch (e) { return { ok: false, uiUrl: uiUrl, error: String(e && e.message || e) }; }
}

function getBooksForDate(dateStr) {
  try { return readers_().booksForDate(prop_('BOOKS_SHEET_ID', BOOKS_SHEET_ID_DEFAULT), dateStr, prop_('READING_APP_URL', READING_APP_URL_DEFAULT)); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function getFilmsForDate(dateStr) {
  try { return readers_().filmsForDate(prop_('MOVIES_SHEET_ID', MOVIES_SHEET_ID_DEFAULT), dateStr, prop_('MOVIE_APP_URL', MOVIE_APP_URL_DEFAULT)); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function getMonthMarks(ym) {
  try { return readers_().monthMarks(prop_('BOOKS_SHEET_ID', BOOKS_SHEET_ID_DEFAULT), prop_('MOVIES_SHEET_ID', MOVIES_SHEET_ID_DEFAULT), ym); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
