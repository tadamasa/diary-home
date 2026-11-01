import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, normMap, datePrefix, parseQuery, searchEntries, snippetHtml, markHtml, timeline, coFeelings, encodeSearch, decodeSearch } from '../js/search.js';

const E = [
  { id: 'a', date: '2024-05-03', time: '09:00', text: '朝、カフェでコーヒーを飲んだ。', feelings: '穏やか、嬉しい', thinkings: '内省' },
  { id: 'b', date: '2025-05-10', time: '21:00', text: '夜にこーひーを淹れて本を読む', feelings: ['穏やか'], thinkings: [] },
  { id: 'c', date: '2025-06-01', time: '07:30', text: '仕事で  ＡＢＣ  の会議。疲れた', feelings: '疲れた', thinkings: '仕事' },
  { id: 'd', date: '2025-06-01', time: '22:00', text: '散歩', feelings: '', thinkings: '' },
];

test('正規化: 全角半角・大文字小文字・カタカナひらがなを揃える', () => {
  assert.equal(norm('ＡＢＣ コーヒー'), 'abc こーひー');
  const m = normMap('ｶﾌｪ');
  assert.equal(m.map.length, m.text.length + 1);
});

test('年月の語', () => {
  assert.equal(datePrefix('2024'), '2024');
  assert.equal(datePrefix('2024-5'), '2024-05');
  assert.equal(datePrefix('2024年5月'), '2024-05');
  assert.equal(datePrefix('２０２４年５月３日'), '2024-05-03');
  assert.equal(datePrefix('2024年13月'), null);
  assert.equal(datePrefix('コーヒー'), null);
  assert.deepEqual(parseQuery('コーヒー  -夜 2025　本'), { words: ['こーひー', '本'], nots: ['夜'], dates: ['2025'] });
});

test('検索: カナとかなを区別せず、AND・除外・年月・タグ', () => {
  assert.deepEqual(searchEntries(E, { q: 'コーヒー' }).map(r => r.e.id), ['b', 'a']);
  assert.deepEqual(searchEntries(E, { q: 'コーヒー', order: 'old' }).map(r => r.e.id), ['a', 'b']);
  assert.deepEqual(searchEntries(E, { q: 'コーヒー -夜' }).map(r => r.e.id), ['a']);
  assert.deepEqual(searchEntries(E, { q: 'こーひー 2024年5月' }).map(r => r.e.id), ['a']);
  assert.deepEqual(searchEntries(E, { q: 'abc' }).map(r => r.e.id), ['c']);
  // タグ名でも当たり、本文の印はない
  const t = searchEntries(E, { q: '内省' });
  assert.deepEqual(t.map(r => r.e.id), ['a']);
  assert.deepEqual(t[0].hits, []);
  assert.ok(t[0].tagHits.has('内省'));
  // タグの絞り込みはすべて含むもの
  assert.deepEqual(searchEntries(E, { feelings: ['穏やか'] }).map(r => r.e.id), ['b', 'a']);
  assert.deepEqual(searchEntries(E, { feelings: ['穏やか', '嬉しい'] }).map(r => r.e.id), ['a']);
  assert.deepEqual(searchEntries(E, { q: '2025-06', thinkings: ['仕事'] }).map(r => r.e.id), ['c']);
  assert.deepEqual(searchEntries(E, {}), []);
});

test('当たった位置は元の本文の位置', () => {
  const [r] = searchEntries(E, { q: 'コーヒー' }).filter(x => x.e.id === 'a');
  assert.deepEqual(r.hits, [[6, 10]]);
  assert.equal(markHtml(E[0].text, r.hits), '朝、カフェで<mark>コーヒー</mark>を飲んだ。');
  const [c] = searchEntries(E, { q: 'abc' });
  assert.equal(E[2].text.slice(...c.hits[0]), 'ＡＢＣ');
  assert.match(snippetHtml(E[2].text, c.hits), /仕事で <mark>ＡＢＣ<\/mark> の会議/);
});

test('抜き出しは長い本文を当たりの前後で切る', () => {
  const text = 'あ'.repeat(200) + '海' + 'い'.repeat(200);
  const [r] = searchEntries([{ id: 'x', date: '2025-01-01', text }], { q: '海' });
  const s = snippetHtml(text, r.hits, 60);
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.match(s, /<mark>海<\/mark>/);
  assert.equal(snippetHtml('<b>', []), '&lt;b&gt;');
});

test('時の帯といっしょにあったこころ', () => {
  const res = searchEntries(E, { feelings: ['穏やか'] });
  const tl = timeline(res);
  assert.deepEqual(tl.years, ['2025', '2024']);
  assert.equal(tl.cells['2025-05'].n, 1);
  assert.deepEqual(coFeelings(res, ['穏やか']), [['嬉しい', 1]]);
});

test('アドレスに検索を残す', () => {
  const s = { q: 'コーヒー 2024', feelings: ['穏やか'], thinkings: [], order: 'old' };
  assert.deepEqual(decodeSearch(encodeSearch(s)), s);
  assert.deepEqual(decodeSearch(''), { q: '', feelings: [], thinkings: [], order: 'new' });
});
