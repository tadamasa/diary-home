// ライブラリ DayReaders(lib/day-readers)を、日記ハブ経由と直接の両方で確かめる。
// 見出しは 2026-11-02 に本物のシートの1行目で確かめたもの。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHub, loadReaders } from './gas-mock.mjs';

const BOOKS_ID = '1WEsS95CKH7JPFuGf7BYzlTV-d6FyTVg0OCOymKHqsZg';
const MOVIES_ID = '156oktIUuxKOcFZn0QYrx6ncY3AFiY-7DjgAIYbiRCm4';
const ENSEN_ID = '1vKPwd3kM4RdD19PEWaCG1R6OuVJGxSjj2njlan6UBFA';
const BH = ['id', 'rev', 'mtime', 'deleted', 'title', 'author', 'status', 'category', 'score', 'finishedAt', 'json'];
const NH = ['id', 'rev', 'mtime', 'deleted', 'date', 'bookId', 'bookTitle', 'kind', 'text', 'quote', 'json'];
const FH = ['id', 'rev', 'mtime', 'deleted', 'title', 'year', 'directors', 'status', 'lastSeen', 'seenCount', 'category', 'tmdbId', 'json'];
const VH = ['id', 'rev', 'mtime', 'deleted', 'date', 'filmId', 'filmTitle', 'place', 'venue', 'score', 'text', 'json'];
const EH = ['event_id', 'ts', 'recorded_ts', 'lat', 'lng', 'place_name', 'actant_type', 'actant_name', 'actant_id', 'verb', 'note', 'media_ref', 'star', 'source', 'tags', 'enrich'];
const TH = ['trace_id', 'ts', 'recorded_ts', 'lat', 'lng', 'place_name', 'photo_key', 'source', 'thumb_b64'];

test('映画: 13列の films(json は13列目)からポスターとジャンルを出す', () => {
  const hub = loadHub();
  hub.addBook(MOVIES_ID, {
    // lastSeen・seenCount が空の行。10列目を json として読むと {} になり、ポスターが出なかった
    films: [FH, ['f1', '1', '1', 'false', 'デューン 砂の惑星PART2', '2024', 'ドゥニ・ヴィルヌーヴ', '観た', '2026-10-31', '1', '', '693134', JSON.stringify({ posterPath: '/u.jpg', genres: ['サイエンスフィクション', 'アドベンチャー', 'ドラマ'] })]],
    views: [VH, ['v1', '1', '1', 'false', '2026-10-31', 'f1', 'デューン', 'theater', 'TOHOシネマズ', '9', '砂。', '{}']],
  });
  const res = hub.post({ token: hub.token, action: 'films', date: '2026-10-31' });
  assert.equal(res.ok, true);
  const f = res.films[0];
  assert.equal(f.title, 'デューン 砂の惑星PART2');
  assert.equal(f.year, '2024');
  assert.equal(f.directors, 'ドゥニ・ヴィルヌーヴ');
  assert.equal(f.place, '映画館');
  assert.equal(f.venue, 'TOHOシネマズ');
  assert.equal(f.poster, 'https://image.tmdb.org/t/p/w185/u.jpg');
  assert.equal(f.genres, 'サイエンスフィクション・アドベンチャー');
});

test('読了本: 列の並びが変わっても、見出しで読む(書影・最初のメモ・リンク)', () => {
  const hub = loadHub();
  const order = ['json', ...BH.filter(x => x !== 'json'), 'extra'];
  const row = o => order.map(k => o[k] ?? '');
  hub.addBook(BOOKS_ID, {
    books: [order,
      row({ id: 'b1', deleted: 'false', title: '構造と力', author: '浅田彰', status: '読了', category: '思想', finishedAt: '2026-10-30', json: JSON.stringify({ cover: 'https://c/1.jpg' }) }),
      row({ id: 'b2', deleted: 'false', title: '読みかけ', status: '読書中', finishedAt: '2026-10-30' }),
      row({ id: 'b3', deleted: 'true', title: '消した', status: '読了', finishedAt: '2026-10-30' })],
    notes: [NH, ['n0', '1', '1', 'true', '', 'b1', '', '', '消したメモ', '', ''], ['n1', '1', '1', 'false', '', 'b1', '', '', '  逃走論へ  ', '', ''], ['n2', '1', '1', 'false', '', 'b1', '', '', '二つ目', '', '']],
  });
  const res = hub.post({ token: hub.token, action: 'books', date: '2026-10-30' });
  assert.equal(res.ok, true);
  assert.equal(res.books.length, 1);
  assert.deepEqual({ ...res.books[0] }, { id: 'b1', title: '構造と力', author: '浅田彰', category: '思想', cover: 'https://c/1.jpg', note: '逃走論へ', url: 'https://tadamasa.github.io/reading-memo/#book/b1' });
});

test('見出しが足りないときは、違う列を読まずに理由を返す', () => {
  const hub = loadHub();
  hub.addBook(BOOKS_ID, { books: [['id', 'deleted', 'title', 'author', 'status', 'category', 'readAt']] });
  const res = hub.post({ token: hub.token, action: 'books', date: '2026-10-30' });
  assert.equal(res.ok, false);
  assert.match(res.error, /books の見出しに finishedAt がありません/);
  const m = hub.post({ token: hub.token, action: 'month', month: '2026-10' });
  assert.equal(m.ok, true);
  assert.match(m.booksError, /finishedAt/);
});

test('縁泉: 縁・家の出入り・痕跡(縁にしたものに印)を時刻順に', () => {
  const hub = loadHub();
  const ev = o => EH.map(k => o[k] ?? '');
  const tr = o => TH.map(k => o[k] ?? '');
  hub.addBook(ENSEN_ID, {
    events: [EH,
      ev({ event_id: 'e1', ts: '2026-10-30T18:20', place_name: '喫茶ひなた', actant_type: '場所', actant_name: '喫茶ひなた', verb: '再会', note: 'ナポリタン', source: 'swarm', enrich: '{"trace_id":"t2"}' }),
      ev({ event_id: 'e2', ts: new Date(2026, 9, 30, 8, 5), actant_type: '人', actant_name: 'Aさん', verb: '出会う' }),
      ev({ event_id: 'e3', ts: '2026-10-30T07:50', tags: '自宅,出発' }),
      ev({ event_id: 'e4', ts: '2026-10-30T21:10', tags: '自宅' }),
      ev({ event_id: 'e5', ts: '2026-10-29T12:00', actant_name: '前の日' })],
    traces: [TH, tr({ trace_id: 't1', ts: '2026-10-30T12:30', place_name: '公園', thumb_b64: 'AAA' }), tr({ trace_id: 't2', ts: '2026-10-30T09:00', place_name: '駅', thumb_b64: 'BBB' }), tr({ trace_id: 't3', ts: '2026-10-31T09:00' })],
  });
  const res = hub.post({ token: hub.token, action: 'ensen', date: '2026-10-30' });
  assert.equal(res.ok, true);
  assert.match(res.uiUrl, /^https:\/\/script\.google\.com\/macros\//);
  assert.deepEqual(res.events.map(e => [e.time, e.name, e.verb]), [['08:05', 'Aさん', '出会う'], ['18:20', '喫茶ひなた', '再会']]);
  assert.deepEqual({ ...res.events[1] }, { time: '18:20', place: '喫茶ひなた', type: '場所', name: '喫茶ひなた', verb: '再会', note: 'ナポリタン', media: '', source: 'swarm' });
  assert.deepEqual(res.homeMoves.map(h => ({ ...h })), [{ time: '07:50', kind: '出発' }, { time: '21:10', kind: '到着' }]);
  assert.deepEqual(res.traces.map(t => ({ ...t })), [{ id: 't2', time: '09:00', place: '駅', thumb: 'BBB', promoted: true }, { id: 't1', time: '12:30', place: '公園', thumb: 'AAA', promoted: false }]);
});

test('日記: その日の CoreData を時刻順に(縁泉ハブが使う形)', () => {
  const hub = loadHub();
  hub.gas.save('2026-10-30', '22:10', '夜', '穏やか,嬉しい', '内省');
  hub.gas.save('2026-10-30', '07:00', '朝');
  hub.gas.save('2026-10-29', '07:00', '前の日');
  hub.diary.getSheetByName('CoreData').appendRow([new Date(2026, 9, 30), new Date(1899, 11, 30, 12, 0), '昼(Dateのまま)', '', '']);
  const R = loadReaders({ SpreadsheetApp: { openById: () => hub.diary }, Utilities: { formatDate: (d, _t, f) => { const p = n => String(n).padStart(2, '0'); return f.replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate())).replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes())); } } });
  const res = R.diaryForDate('x', '2026-10-30', 'https://tadamasa.github.io/diary-home/');
  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://tadamasa.github.io/diary-home/#day/2026-10-30');
  assert.deepEqual(Array.from(res.entries, e => ({ ...e })), [
    { time: '07:00', text: '朝', feelings: '', thinkings: '' },
    { time: '12:00', text: '昼(Dateのまま)', feelings: '', thinkings: '' },
    { time: '22:10', text: '夜', feelings: '穏やか,嬉しい', thinkings: '内省' },
  ]);
  assert.equal(R.diaryForDate('x', '2026/10/30', '').ok, false);
});

test('ライブラリを追加する前の版でも同期は動き、その日のまわりは理由つきで空', () => {
  const hub = loadHub({ withReaders: false });
  hub.gas.save('2026-10-30', '07:00', '朝');
  assert.equal(hub.post({ token: hub.token, since: 0 }).entries.length, 1);
  const res = hub.post({ token: hub.token, action: 'books', date: '2026-10-30' });
  assert.equal(res.ok, false);
  assert.match(res.error, /DayReaders/);
  assert.equal(hub.post({ token: hub.token, action: 'ensen', date: '2026-10-30' }).ok, false);
});
