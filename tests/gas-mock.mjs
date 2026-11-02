// Apps Script の最小限の模擬。hub/Code.gs を Node で動かして確かめるためのもの。
// 「日記の記録」スプレッドシート(CoreData・タグ管理・プロンプト管理)を作り、GAS日記の書き方もまねる。
import fs from 'fs';
import vm from 'vm';

function makeBook() {
  const sheets = new Map();
  const ss = {
    sheets,
    getSheetByName: n => (sheets.get(n) || {}).api || null,
    insertSheet: name => {
      const sh = { name, rows: [], maxRows: 1000, frozen: 0 };
      // ' で始まる文字は、表では ' を除いた文字になる(Googleスプレッドシートと同じ)
      const strip = x => (typeof x === 'string' && x.startsWith("'") ? x.slice(1) : x);
      const range = (r, c, nr = 1, nc = 1) => {
        if (r + nr - 1 > sh.maxRows) throw new Error(`範囲外 ${r + nr - 1} > ${sh.maxRows}`);
        const api = {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((sh.rows[r - 1 + i] || [])[c - 1 + j] ?? ''))),
          getValue: () => api.getValues()[0][0],
          setValues: v => { v.forEach((row, i) => { sh.rows[r - 1 + i] = sh.rows[r - 1 + i] || []; row.forEach((x, j) => { sh.rows[r - 1 + i][c - 1 + j] = strip(x); }); }); return api; },
          setValue: x => api.setValues([[x]]),
          setNumberFormat: () => api,
          setFontWeight: () => api,
        };
        return api;
      };
      const lastRow = () => { let n = sh.rows.length; while (n > 0 && !(sh.rows[n - 1] || []).some(x => x !== '' && x != null)) n--; return n; };
      sh.api = {
        getRange: range,
        getLastRow: lastRow,
        getLastColumn: () => Math.max(0, ...sh.rows.slice(0, lastRow()).map(x => (x || []).filter(v => v !== undefined).length)),
        getMaxRows: () => sh.maxRows,
        insertRowsAfter: (_, n) => { sh.maxRows += n; },
        setFrozenRows: n => { sh.frozen = n; },
        appendRow: row => { const at = lastRow(); if (at + 1 > sh.maxRows) sh.maxRows = at + 1; sh.rows[at] = row.map(strip); },
        deleteRow: r => { sh.rows.splice(r - 1, 1); },
        getDataRange: () => { const n = lastRow(); const w = Math.max(1, ...sh.rows.slice(0, n).map(x => (x || []).length)); return range(1, 1, Math.max(n, 1), w); },
        getParent: () => ss,
      };
      sheets.set(name, sh);
      return sh.api;
    },
  };
  return ss;
}

// ライブラリ DayReaders(lib/day-readers)を、呼ぶ側と同じ SpreadsheetApp・Utilities で別の場所に読み込む。
// Apps Script と同じく、呼ぶ側からは DayReaders.関数名 で見える
export function loadReaders(ctx) {
  const lib = { SpreadsheetApp: ctx.SpreadsheetApp, Utilities: ctx.Utilities, Date, Math, JSON, String, Number, Array, Object, encodeURIComponent };
  vm.createContext(lib);
  vm.runInContext(fs.readFileSync(new URL('../lib/day-readers/DayReaders.gs', import.meta.url), 'utf8'), lib);
  return lib;
}

export function loadHub({ withReaders = true } = {}) {
  const diary = makeBook();
  const core = diary.insertSheet('CoreData');
  core.appendRow(['Date', 'Time', 'Text', 'Feelings', 'Thinkings']);
  diary.insertSheet('タグ管理').appendRow(['Category', 'TagName']);
  diary.getSheetByName('タグ管理').appendRow(['Feeling', '穏やか']);
  diary.getSheetByName('タグ管理').appendRow(['Thinking', '内省']);
  diary.insertSheet('プロンプト管理').appendRow(['項目名', 'プロンプト内容']);
  diary.getSheetByName('プロンプト管理').appendRow(['Geminiサジェスト', '日記:{{text}}']);
  const props = {};
  let uuid = 0;
  // ほかのハブ(映画など)は ID ごとに別のブックとして模擬する
  const books = {};
  const addBook = (id, sheets) => {
    const b = makeBook();
    for (const [name, rows] of Object.entries(sheets)) { const sh = b.insertSheet(name); rows.forEach(r => sh.appendRow(r)); }
    books[id] = b;
    return b;
  };
  // カレンダー: { calendars: [{ name, color, hidden, selected, events: [{ title, start: Date, end: Date, allDay, location }] }] }
  const calendar = { calendars: [] };
  const calApi = c => ({
    getId: () => c.id || c.name, getName: () => c.name, isMyPrimaryCalendar: () => !!c.primary, getColor: () => c.color || '#888', isHidden: () => !!c.hidden, isSelected: () => c.selected !== false,
    getEventsForDay: day => c.events.filter(e => e.start.toDateString() === day.toDateString()).map(e => ({
      getTitle: () => e.title, getStartTime: () => e.start, getEndTime: () => e.end, isAllDayEvent: () => !!e.allDay, getLocation: () => e.location || '',
    })),
  });
  const ctx = {
    CalendarApp: { getAllCalendars: () => calendar.calendars.map(calApi), getCalendarById: id => { const c = calendar.calendars.find(x => x.id === id); return c ? calApi(c) : null; } },
    SpreadsheetApp: { openById: id => (books[id] || diary) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Utilities: {
      getUuid: () => `0000${(++uuid).toString(16).padStart(4, '0')}-1111-2222-3333-444455556666`,
      formatDate: (d, _tz, f) => {
        const p = n => String(n).padStart(2, '0');
        return f.replace(/'([^']*)'/g, '$1').replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate())).replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes()));
      },
    },
    Logger: { log() {} },
    Date, Math, JSON, String, Number, Array, Object,
  };
  if (withReaders) ctx.DayReaders = loadReaders(ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../hub/Code.gs', import.meta.url), 'utf8'), ctx);
  ctx.setup();
  // GAS日記(コード.js)の書き方: 末尾に5列を足す / 行番号で5列を上書き / 行ごと消す
  const gas = {
    save: (date, time, text, f = '', t = '') => core.appendRow([`'${date}`, `'${time}`, text, f, t]),
    update: (rowIndex, date, time, text, f = '', t = '') => core.getRange(rowIndex, 1, 1, 5).setValues([[`'${date}`, `'${time}`, text, f, t]]),
    remove: rowIndex => core.deleteRow(rowIndex),
  };
  return {
    token: props.TOKEN,
    props,
    diary,
    rows: () => diary.sheets.get('CoreData').rows,
    gas,
    calendar,
    addBook,
    post: body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text),
  };
}
