import test from 'node:test';
import assert from 'node:assert/strict';
import { monthCells, shiftMonth, splitTags, entriesOn, tagChoices, buildPrompt, renderAnswer, makeEntry, dateLabel, weekCells, insertLine } from '../js/diary.js';

test('カレンダー: 2026年10月は木曜始まり', () => {
  const c = monthCells(2026, 10);
  assert.equal(c.filter(x => x === null).length, 4);
  assert.equal(c[4], '2026-10-01');
  assert.equal(c.at(-1), '2026-10-31');
  assert.deepEqual(shiftMonth(2026, 1, -1), [2025, 12]);
  assert.deepEqual(shiftMonth(2026, 10, 12), [2027, 10]);
  assert.equal(dateLabel('2026-10-30'), '2026年10月30日(金)');
});

test('タグは「,」「、」空白混じりも分ける', () => {
  assert.deepEqual(splitTags('穏やか、 嬉しい,,内省 '), ['穏やか', '嬉しい', '内省']);
  assert.deepEqual(tagChoices(['a'], new Set(['b', 'a'])), ['a', 'b']);
});

test('その日の記録を新しい時刻から', () => {
  const es = [{ date: '2026-10-30', time: '07:00' }, { date: '2026-10-30', time: '22:00' }, { date: '2026-10-29', time: '23:00' }];
  assert.deepEqual(entriesOn(es, '2026-10-30').map(e => e.time), ['22:00', '07:00']);
});

test('プロンプト管理の指示文に差し込む', () => {
  assert.equal(buildPrompt({ X: 'a{{text}}b{{text}}' }, 'X', { text: '日' }), 'a日b日');
  assert.match(buildPrompt({}, 'Geminiニュース検索', { dateStr: '2026-10-30' }), /^2026-10-30 の/);
});

test('AIの返答はエスケープしてからリンクだけ生かす', () => {
  const h = renderAnswer('<img src=x onerror=alert(1)> [本](https://ex.com/a?b=1&c=2)\n**太**');
  assert.ok(!h.includes('<img'));
  assert.ok(h.includes('<a href="https://ex.com/a?b=1&amp;c=2"'));
  assert.ok(h.includes('<br><b>太</b>'));
  assert.ok(!renderAnswer('[x](javascript:alert(1))').includes('<a'));
});

test('記録を作る', () => {
  const e = makeEntry({ datetime: '2026-10-30T21:05', text: 't', feelings: new Set(['a']), thinkings: new Set() }, () => 'id1');
  assert.deepEqual(e, { id: 'id1', date: '2026-10-30', time: '21:05', text: 't', feelings: ['a'], thinkings: [] });
});

test('日送りとフリックの判定', async () => {
  const { shiftDay, swipeDir } = await import('../js/diary.js');
  assert.equal(shiftDay('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2028-02-28', 1), '2028-02-29');
  assert.equal(swipeDir(-120, 10, 200), 1);
  assert.equal(swipeDir(120, 10, 200), -1);
  assert.equal(swipeDir(-120, 80, 200), 0); // 斜めはスクロール扱い
  assert.equal(swipeDir(-40, 0, 200), 0);
  assert.equal(swipeDir(-120, 0, 900), 0);
});

test('週: 日曜はじまりで月をまたぐ', () => {
  assert.deepEqual(weekCells('2026-11-02'), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
  assert.deepEqual(weekCells('2026-10-01').slice(0, 5), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
});

test('本文への差し込み: カーソルの位置に1行、前後の改行を補う', () => {
  assert.deepEqual(insertLine('', [0, 0], '10:00 定例'), { text: '10:00 定例\n', caret: 9 });
  const r = insertLine('朝\n夜', [1, 1], '昼');
  assert.equal(r.text, '朝\n昼\n夜');
  assert.equal(insertLine('朝', [1, 1], '昼').text, '朝\n昼\n');
});

test('縁泉の作品(reading/movie)は本・映画の欄が読めたときだけ出さない', async () => {
  const { ensenEventsShown } = await import('../js/diary.js');
  const evs = [
    { name: '渋谷', source: 'swarm' },
    { name: '現実はいつも対話から生まれる', source: 'reading' },
    { name: 'シャドウズ・エッジ', source: 'movie' },
    { name: '友だち', source: '' },
  ];
  assert.deepEqual(ensenEventsShown(evs, { books: true, films: true }).map(e => e.name), ['渋谷', '友だち']);
  assert.deepEqual(ensenEventsShown(evs, { books: false, films: true }).map(e => e.name), ['渋谷', '現実はいつも対話から生まれる', '友だち']);
  assert.deepEqual(ensenEventsShown(evs, { books: true, films: false }).map(e => e.name), ['渋谷', 'シャドウズ・エッジ', '友だち']);
  assert.deepEqual(ensenEventsShown(evs).map(e => e.name), evs.map(e => e.name));
  assert.deepEqual(ensenEventsShown(undefined, { books: true }), []);
});
