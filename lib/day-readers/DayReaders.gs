/**
 * DayReaders: 「その日」のまわりを読む Apps Script ライブラリ(読み取りのみ)。
 *
 * 使う側: 日記ハブ(tadamasa/diary-home の hub/Code.gs)、縁泉ハブ(tadamasa/ensen-home の hub/Code.gs)、日記v2(コード.js)。
 * 使い方と公開の手順は lib/day-readers/README.md。
 *
 * 約束
 *  - 書き込まない。SpreadsheetApp.openById で開いて読むだけ。
 *  - シートIDとアプリのURLは引数で受け取る。PropertiesService はこの中で読まない(呼ぶ側のプロパティを使う)。
 *  - 列は位置で決め打ちせず、1行目の見出しから列番号を引く。列が足されても並びが変わっても読める。
 *    必要な見出しが無いときは、黙って違う列を読まずに { ok: false, error: '… の見出しに … がありません' } を返す。
 *  - 例外は投げず、{ ok: false, error } で返す(呼ぶ側の画面の一部だけが空になる)。
 *
 * 読む約束(2026-11-02 に各シートの1行目で確認した見出し。★はこのライブラリが読む列)
 *  読書ハブ  books : id★ rev mtime deleted★ title★ author★ status★ category★ score finishedAt★ json★(cover)
 *            notes : id rev mtime deleted★ date bookId★ bookTitle kind text★ quote json
 *  映画ハブ  views : id rev mtime deleted★ date★ filmId★ filmTitle★ place★ venue★ score★ text★ json
 *            films : id★ rev mtime deleted title★ year★ directors★ status lastSeen seenCount category tmdbId json★(posterPath, genres)
 *  縁泉      events: event_id ts★ recorded_ts lat lng place_name★ actant_type★ actant_name★ actant_id verb★ note★ media_ref★ star source★ tags★ enrich★(trace_id)
 *            traces: trace_id★ ts★ recorded_ts lat lng place_name★ photo_key source thumb_b64★
 *  日記の記録 CoreData: Date★ Time★ Text★ Feelings★ Thinkings★ Id
 * 見出しの名前を変えるときは、このファイルと使う側(上の3つ)に響く。
 */

var TIMEZONE = 'Asia/Tokyo';
var VERSION = 1;
var PLACE_LABEL = { stream: '配信', theater: '映画館', tv: 'テレビ', disc: 'ディスク', other: 'その他' };
var TMDB_POSTER = 'https://image.tmdb.org/t/p/w185';

// ========== 読了本 ==========
/**
 * その日に読み終えた本(books の status が「読了」で finishedAt がその日、deleted でない)。
 * @return {{ok:boolean, books?:Array<{id,title,author,category,cover,note,url}>, error?:string}}
 */
function booksForDate(booksSheetId, dateStr, appUrl) {
  try {
    if (!isDate_(dateStr)) return { ok: false, error: 'bad date' };
    var ss = SpreadsheetApp.openById(booksSheetId);
    var t = table_(ss, 'books', ['id', 'deleted', 'title', 'author', 'status', 'category', 'finishedAt'], ['json']);
    var books = [];
    t.rows.forEach(function (r, i) {
      if (isTrue_(r[t.c.deleted]) || String(r[t.c.status]) !== '読了' || dateOf_(r[t.c.finishedAt]) !== dateStr) return;
      books.push({ id: String(r[t.c.id]), title: str_(r[t.c.title]), author: str_(r[t.c.author]), category: str_(r[t.c.category]), _row: i + 2 });
    });
    if (books.length) {
      var notes = firstNotes_(ss, books);
      books.forEach(function (b) {
        b.cover = t.c.json === undefined ? '' : (json_(t.sh.getRange(b._row, t.c.json + 1).getValue()).cover || '');
        b.note = notes[b.id] || '';
        b.url = String(appUrl || '') + '#book/' + encodeURIComponent(b.id);
        delete b._row;
      });
    }
    return { ok: true, books: books };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// notes の、その本の最初の(表で上にある)メモ本文
function firstNotes_(ss, books) {
  var want = {};
  books.forEach(function (b) { want[b.id] = true; });
  var out = {};
  if (!ss.getSheetByName('notes')) return out;
  var t = table_(ss, 'notes', ['deleted', 'bookId', 'text'], []);
  t.rows.forEach(function (r) {
    var id = String(r[t.c.bookId]);
    if (!want[id] || out[id] || isTrue_(r[t.c.deleted])) return;
    var text = String(r[t.c.text] == null ? '' : r[t.c.text]).trim();
    if (text) out[id] = text;
  });
  return out;
}

// ========== 観た映画 ==========
/**
 * その日に観た映画(views の date がその日、deleted でない)。年だけ・月だけの「思い出し」記録は date が日付にならないので入らない。
 * ポスター・ジャンル・監督・年は films から取る。
 * @return {{ok:boolean, films?:Array<{filmId,title,place,venue,score,text,year,directors,poster,genres,url}>, error?:string}}
 */
function filmsForDate(moviesSheetId, dateStr, appUrl) {
  try {
    if (!isDate_(dateStr)) return { ok: false, error: 'bad date' };
    var ss = SpreadsheetApp.openById(moviesSheetId);
    var v = table_(ss, 'views', ['deleted', 'date', 'filmId', 'filmTitle', 'place', 'venue', 'score', 'text'], []);
    var films = [];
    v.rows.forEach(function (r) {
      if (isTrue_(r[v.c.deleted]) || dateOf_(r[v.c.date]) !== dateStr) return;
      var score = r[v.c.score];
      films.push({ filmId: String(r[v.c.filmId]), title: str_(r[v.c.filmTitle]), place: PLACE_LABEL[String(r[v.c.place])] || str_(r[v.c.place]), venue: str_(r[v.c.venue]), score: score === '' || score == null ? '' : String(score), text: str_(r[v.c.text]) });
    });
    if (films.length) {
      var info = filmInfo_(ss, films);
      films.forEach(function (f) {
        var x = info[f.filmId] || {};
        f.title = x.title || f.title;
        f.year = x.year || '';
        f.directors = x.directors || '';
        f.poster = x.poster || '';
        f.genres = x.genres || '';
        f.url = String(appUrl || '') + '#film/' + encodeURIComponent(f.filmId);
      });
    }
    return { ok: true, films: films };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// films から、欲しい映画の行だけを読む(json は大きいので全行は読まない)
function filmInfo_(ss, films) {
  var out = {};
  if (!ss.getSheetByName('films')) return out;
  var t = head_(ss, 'films', ['id', 'title', 'year', 'directors'], ['json']);
  if (t.last < 2) return out;
  var want = {};
  films.forEach(function (f) { want[f.filmId] = true; });
  var ids = t.sh.getRange(2, t.c.id + 1, t.last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i][0]);
    if (!want[id] || out[id]) continue;
    var r = t.sh.getRange(i + 2, 1, 1, t.width).getValues()[0];
    var j = t.c.json === undefined ? {} : json_(r[t.c.json]);
    out[id] = {
      title: str_(r[t.c.title]), year: str_(r[t.c.year]), directors: str_(r[t.c.directors]),
      poster: j.posterPath ? TMDB_POSTER + j.posterPath : '',
      genres: (Array.isArray(j.genres) ? j.genres : []).slice(0, 2).join('・'),
    };
  }
  return out;
}

// ========== カレンダーの印 ==========
/**
 * その月に本を読み終えた日・映画を観た日(YYYY-MM-DD の昇順、重なりなし)。
 * 片方のシートが読めなくても、もう片方は返す(booksError / filmsError に理由)。
 * @return {{ok:boolean, month:string, books:string[], films:string[], booksError?:string, filmsError?:string}}
 */
function monthMarks(booksSheetId, moviesSheetId, ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym))) return { ok: false, error: 'bad month' };
  var out = { ok: true, month: ym, books: [], films: [] };
  var pick = function (t, col, keep) {
    var set = {};
    t.rows.forEach(function (r) { var d = dateOf_(r[t.c[col]]); if (d.length === 10 && d.substring(0, 7) === ym && keep(r)) set[d] = true; });
    return Object.keys(set).sort();
  };
  try {
    var b = table_(SpreadsheetApp.openById(booksSheetId), 'books', ['deleted', 'status', 'finishedAt'], []);
    out.books = pick(b, 'finishedAt', function (r) { return !isTrue_(r[b.c.deleted]) && String(r[b.c.status]) === '読了'; });
  } catch (e) { out.booksError = String(e && e.message || e); }
  try {
    var v = table_(SpreadsheetApp.openById(moviesSheetId), 'views', ['deleted', 'date'], []);
    out.films = pick(v, 'date', function (r) { return !isTrue_(r[v.c.deleted]); });
  } catch (e) { out.filmsError = String(e && e.message || e); }
  return out;
}

// ========== 縁泉 ==========
/**
 * その日の縁泉: 縁(events)、家の出入り(tags に「自宅」を含む行)、写真の痕跡(traces)。
 * 痕跡のうち、events の enrich に trace_id が書かれているもの(縁に昇格したもの)は promoted: true。
 * @return {{ok:boolean, events?:Array<{time,place,type,name,verb,note,media,source}>, homeMoves?:Array<{time,kind}>, traces?:Array<{id,time,place,thumb,promoted}>, error?:string}}
 */
function ensenForDate(ensenSheetId, dateStr) {
  try {
    if (!isDate_(dateStr)) return { ok: false, error: 'bad date' };
    var ss = SpreadsheetApp.openById(ensenSheetId);
    var t = table_(ss, 'events', ['ts', 'place_name', 'actant_type', 'actant_name', 'verb', 'note', 'media_ref', 'source', 'tags'], ['enrich']);
    var events = [];
    var homeMoves = [];
    var promoted = {};
    t.rows.forEach(function (r) {
      if (t.c.enrich !== undefined) {
        var m = String(r[t.c.enrich] || '').match(/"trace_id"\s*:\s*"([^"]+)"/);
        if (m) promoted[m[1]] = true;
      }
      var ts = stamp_(r[t.c.ts]);
      if (ts.substring(0, 10) !== dateStr) return;
      var time = ts.substring(11, 16);
      var tags = String(r[t.c.tags] || '');
      if (tags.indexOf('自宅') !== -1) {
        homeMoves.push({ time: time, kind: tags.indexOf('出発') !== -1 ? '出発' : '到着' });
        return;
      }
      events.push({ time: time, place: str_(r[t.c.place_name]), type: str_(r[t.c.actant_type]), name: str_(r[t.c.actant_name]), verb: str_(r[t.c.verb]), note: str_(r[t.c.note]), media: str_(r[t.c.media_ref]), source: str_(r[t.c.source]) });
    });
    events.sort(byTime_);
    homeMoves.sort(byTime_);
    return { ok: true, events: events, homeMoves: homeMoves, traces: traces_(ss, dateStr, promoted) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// traces は1万行を超え、thumb_b64 が大きいので、ts の列だけ読んでから当日の行を読む
function traces_(ss, dateStr, promoted) {
  if (!ss.getSheetByName('traces')) return [];
  var t = head_(ss, 'traces', ['trace_id', 'ts', 'place_name', 'thumb_b64'], []);
  if (t.last < 2) return [];
  var tsCol = t.sh.getRange(2, t.c.ts + 1, t.last - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < tsCol.length; i++) {
    var ts = stamp_(tsCol[i][0]);
    if (ts.substring(0, 10) !== dateStr) continue;
    var r = t.sh.getRange(i + 2, 1, 1, t.width).getValues()[0];
    var id = String(r[t.c.trace_id]);
    out.push({ id: id, time: ts.substring(11, 16), place: str_(r[t.c.place_name]), thumb: str_(r[t.c.thumb_b64]), promoted: !!promoted[id] });
  }
  out.sort(byTime_);
  return out;
}

// ========== 日記 ==========
/**
 * その日の日記(「日記の記録」CoreData の Date がその日で、本文があるもの)を時刻順に。
 * @return {{ok:boolean, url?:string, entries?:Array<{time,text,feelings,thinkings}>, error?:string}}
 */
function diaryForDate(diarySheetId, dateStr, appUrl) {
  try {
    if (!isDate_(dateStr)) return { ok: false, error: 'bad date' };
    var t = table_(SpreadsheetApp.openById(diarySheetId), 'CoreData', ['Date', 'Time', 'Text', 'Feelings', 'Thinkings'], []);
    var out = [];
    t.rows.forEach(function (r) {
      if (dateOf_(r[t.c.Date]) !== dateStr || !String(r[t.c.Text] == null ? '' : r[t.c.Text]).trim()) return;
      var tm = r[t.c.Time] instanceof Date ? Utilities.formatDate(r[t.c.Time], TIMEZONE, 'HH:mm') : String(r[t.c.Time] == null ? '' : r[t.c.Time]).trim().slice(0, 5);
      out.push({ time: tm, text: String(r[t.c.Text]), feelings: str_(r[t.c.Feelings]).trim(), thinkings: str_(r[t.c.Thinkings]).trim() });
    });
    out.sort(byTime_);
    return { ok: true, url: String(appUrl || '') + '#day/' + dateStr, entries: out };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ========== 見出しから列を引く ==========
// need の見出しが無ければ投げる。opt は無くてもよい(c[name] が undefined になる)。width は読む列数(need/opt の最も右まで)
function head_(ss, name, need, opt) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('シート ' + name + ' がありません');
  var last = sh.getLastRow();
  var cols = sh.getLastColumn();
  var head = last < 1 || cols < 1 ? [] : sh.getRange(1, 1, 1, cols).getValues()[0];
  var c = {};
  need.concat(opt).forEach(function (n) {
    for (var i = 0; i < head.length; i++) if (String(head[i]).trim() === n) { c[n] = i; return; }
  });
  var miss = need.filter(function (n) { return c[n] === undefined; });
  if (miss.length) throw new Error(name + ' の見出しに ' + miss.join(', ') + ' がありません');
  var width = 1;
  Object.keys(c).forEach(function (k) { width = Math.max(width, c[k] + 1); });
  return { sh: sh, c: c, last: last, width: width };
}

function table_(ss, name, need, opt) {
  var t = head_(ss, name, need, opt);
  t.rows = t.last < 2 ? [] : t.sh.getRange(2, 1, t.last - 1, t.width).getValues();
  return t;
}

function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); }
function isTrue_(v) { return v === true || String(v).toLowerCase() === 'true'; }
function str_(v) { return String(v == null ? '' : v); }
function dateOf_(v) { return v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd') : String(v == null ? '' : v).trim().substring(0, 10); }
function stamp_(v) { return v instanceof Date ? Utilities.formatDate(v, TIMEZONE, "yyyy-MM-dd'T'HH:mm") : String(v == null ? '' : v); }
function json_(v) { try { var j = JSON.parse(v || '{}'); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
function byTime_(a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; }
