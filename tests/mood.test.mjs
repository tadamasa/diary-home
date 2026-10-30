import test from 'node:test';
import assert from 'node:assert/strict';
import { hueOf, moodOf, moonAge, moonName, moonPath, skyOf, AFFECT } from '../js/mood.js';

test('円環の角度から色相: 快=金、不快=菫、静かな快=若草', () => {
  assert.equal(hueOf(1, 0), 46);
  assert.equal(hueOf(-1, 0), 275);
  const calm = hueOf(0.6, -0.6); // 穏やか
  assert.ok(calm > 90 && calm < 170, String(calm));
  const angry = hueOf(-0.8, 0.8); // 怒り
  assert.ok(angry > 300 || angry < 10, String(angry));
});

test('一日の色は平均。Feelingがなければ null', () => {
  assert.equal(moodOf([]), null);
  const m = moodOf(['嬉しい', '悲しい']);
  assert.ok(m.r < 0.3); // 打ち消し合うと淡くなる
  assert.ok(moodOf(['ワクワク']).r > 0.9);
  assert.ok(moodOf(['未知のタグ']).r <= 0.35);
});

test('タグ管理のFeelingはすべて円の中', () => {
  for (const [k, [v, a]] of Object.entries(AFFECT)) assert.ok(Math.hypot(v, a) <= 1.3, k);
});

test('月齢: 2026-10-26 前後は満月、2026-11-09 前後は新月', () => {
  // 平均朔望月での計算が、2026年10月下旬の満月・11月上旬の新月の並びになっていること
  assert.equal(moonName(moonAge(new Date(Date.UTC(2026, 9, 26, 12)))), '満月');
  assert.match(moonName(moonAge(new Date(Date.UTC(2026, 10, 9, 12)))), /新月|有明/);
  assert.match(moonPath(7.4), /^M0,-10 A10,10 0 0 1 0,10/);
});

test('時間帯', () => {
  assert.equal(skyOf(new Date(2026, 0, 1, 5, 30)), 'dawn');
  assert.equal(skyOf(new Date(2026, 0, 1, 17)), 'dusk');
  assert.equal(skyOf(new Date(2026, 0, 1, 23)), 'night');
});

test('タグの並べ方: 色の順は円をひと回り、よく使う順、シートの順', async () => {
  const { sortTags, setCustomAffect } = await import('../js/mood.js');
  setCustomAffect({});
  const list = ['悲しい', '普通', '嬉しい', '怒り', '穏やか', 'ワクワク'];
  assert.deepEqual(sortTags(list, 'color'), ['嬉しい', 'ワクワク', '怒り', '悲しい', '穏やか', '普通']);
  assert.deepEqual(sortTags(list, 'often', { 穏やか: 5, 怒り: 2 }), ['穏やか', '怒り', '悲しい', '普通', '嬉しい', 'ワクワク']);
  assert.deepEqual(sortTags(list, 'sheet'), list);
  assert.deepEqual(sortTags(['b', 'a'], 'color', {}, false), ['b', 'a']);
});
