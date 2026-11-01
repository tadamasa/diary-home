import test from 'node:test';
import assert from 'node:assert/strict';
import { monthCells, shiftMonth, splitTags, entriesOn, tagChoices, buildPrompt, renderAnswer, makeEntry, dateLabel } from '../js/diary.js';

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
