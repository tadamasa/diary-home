import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHub } from './gas-mock.mjs';

const entry = (id, mtime, data) => ({ id, mtime, data: { id, date: '2026-10-30', time: '21:00', text: '', feelings: [], thinkings: [], ...data } });

test('合言葉が違えば断る', () => {
  const hub = loadHub();
  assert.equal(hub.post({ token: 'x' }).error, 'unauthorized');
});

test('GAS日記で書いた行に Id を振り、アプリへ流す', () => {
  const hub = loadHub();
  hub.gas.save('2026-10-29', '22:10', '古い日記', '穏やか,嬉しい', '内省');
  hub.gas.save('2026-10-30', '07:00', '朝');
  const res = hub.post({ token: hub.token, since: 0 });
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 2);
  const e = res.entries.find(x => x.data.text === '古い日記');
  assert.deepEqual([...e.data.feelings], ['穏やか', '嬉しい']);
  assert.deepEqual([...e.data.thinkings], ['内省']);
  assert.equal(e.data.date, '2026-10-29');
  assert.equal(hub.rows()[1][5], e.id); // F列に Id
  assert.equal(hub.rows()[0][5], 'Id');
  assert.deepEqual(res.tags, { feelings: ['穏やか'], thinkings: ['内省'] });
  assert.equal(res.prompts['Geminiサジェスト'], '日記:{{text}}');
  // 2回目は何も変わっていないので空
  const again = hub.post({ token: hub.token, since: res.rev });
  assert.equal(again.entries.length, 0);
  assert.equal(again.rev, res.rev);
});

test('アプリの記録をGAS日記と同じ形で書き、5列の形を崩さない', () => {
  const hub = loadHub();
  const res = hub.post({ token: hub.token, since: 0, entries: [entry('a1', 100, { text: '=1+1 のような本文', feelings: ['穏やか'], thinkings: ['内省', '問い'] })] });
  const row = hub.rows()[1];
  assert.deepEqual([...row], ['2026-10-30', '21:00', '=1+1 のような本文', '穏やか', '内省,問い', 'a1']);
  assert.equal(res.entries.length, 1);
  // 返ってきたものは送った本人の記録。mtime は送ったまま
  assert.equal(res.entries[0].mtime, 100);
  // 次の同期で、自分で書いた行を「GAS側の変更」と誤認しない
  assert.equal(hub.post({ token: hub.token, since: res.rev }).entries.length, 0);
});

test('GAS日記で直した行・消した行を見つける', () => {
  const hub = loadHub();
  hub.gas.save('2026-10-28', '20:00', '一', '', '');
  hub.gas.save('2026-10-29', '20:00', '二', '', '');
  hub.gas.save('2026-10-30', '20:00', '三', '', '');
  const first = hub.post({ token: hub.token, since: 0 });
  const idOf = t => first.entries.find(e => e.data.text === t).id;
  hub.gas.update(3, '2026-10-29', '20:30', '二(直した)', '嬉しい', '');
  hub.gas.remove(2); // 「一」を行ごと削除。下の行が繰り上がる
  const res = hub.post({ token: hub.token, since: first.rev });
  const byId = Object.fromEntries(res.entries.map(e => [e.id, e]));
  assert.equal(res.entries.length, 2);
  assert.equal(byId[idOf('一')].deleted, true);
  assert.equal(byId[idOf('二')].data.text, '二(直した)');
  assert.equal(byId[idOf('二')].data.time, '20:30');
  assert.equal(byId[idOf('三')], undefined); // 行は動いたが中身は同じ
});

test('アプリでの削除は行を消さず空にする(GAS側の行番号がずれない)', () => {
  const hub = loadHub();
  hub.gas.save('2026-10-29', '20:00', '残す');
  hub.post({ token: hub.token, since: 0, entries: [entry('a1', 100, { text: '消す' })] });
  hub.gas.save('2026-10-30', '22:00', 'あと');
  const before = hub.rows().length;
  const res = hub.post({ token: hub.token, since: 0, entries: [{ id: 'a1', mtime: 200, deleted: true }] });
  assert.equal(hub.rows().length, before);
  assert.deepEqual([...hub.rows()[2].slice(0, 5)], ['', '', '', '', '']);
  assert.equal(res.entries.find(e => e.id === 'a1').deleted, true);
  assert.equal(res.entries.filter(e => !e.deleted).length, 2);
  // 空の行は新しい記録として拾わない
  assert.equal(hub.post({ token: hub.token, since: res.rev }).entries.length, 0);
});

test('古い書き込みは無視し、新しい方を残す', () => {
  const hub = loadHub();
  hub.post({ token: hub.token, since: 0, entries: [entry('a1', 200, { text: '新' })] });
  hub.post({ token: hub.token, since: 0, entries: [entry('a1', 100, { text: '古' })] });
  assert.equal(hub.rows()[1][2], '新');
});

test('タグを足す(重なりは足さない)', () => {
  const hub = loadHub();
  const res = hub.post({ token: hub.token, since: 0, newTags: [{ category: 'Feeling', name: '静か' }, { category: 'Thinking', name: '内省' }] });
  assert.deepEqual(res.tags, { feelings: ['穏やか', '静か'], thinkings: ['内省'] });
});

test('多いときは400件ずつ返し、1000行を超えても書ける', () => {
  const hub = loadHub();
  for (let i = 0; i < 1200; i++) hub.gas.save('2026-01-01', '10:00', `n${i}`);
  let since = 0;
  const seen = new Set();
  for (let guard = 0; guard < 10; guard++) {
    const res = hub.post({ token: hub.token, since });
    res.entries.forEach(e => seen.add(e.id));
    since = res.rev;
    if (!res.more) break;
  }
  assert.equal(seen.size, 1200);
});

test('日付・時刻が Date のまま入った古い行も読める', () => {
  const hub = loadHub();
  hub.diary.getSheetByName('CoreData').appendRow([new Date(2025, 0, 5), new Date(1899, 11, 30, 9, 5), '昔', '', '']);
  const res = hub.post({ token: hub.token, since: 0 });
  assert.equal(res.entries[0].data.date, '2025-01-05');
  assert.equal(res.entries[0].data.time, '09:05');
});

test('その日の予定を、表示中のカレンダーから時刻順に返す', () => {
  const hub = loadHub();
  const d = (h, m = 0) => new Date(2026, 9, 30, h, m);
  hub.calendar.calendars.push(
    { name: '仕事', color: '#039be5', events: [{ title: '定例', start: d(10), end: d(11) }, { title: '翌日', start: new Date(2026, 9, 31, 9), end: new Date(2026, 9, 31, 10) }] },
    { name: '個人', events: [{ title: '歯医者', start: d(8, 30), end: d(9), location: '駅前' }, { title: '誕生日', start: d(0), end: d(0), allDay: true }] },
    { name: '隠し', hidden: true, events: [{ title: '見せない', start: d(12), end: d(13) }] },
  );
  const res = hub.post({ token: hub.token, action: 'calendar', date: '2026-10-30' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.events.map(e => e.title), ['誕生日', '歯医者', '定例']);
  assert.equal(res.events[1].start, '08:30');
  assert.equal(res.events[1].location, '駅前');
  assert.equal(hub.post({ token: 'x', action: 'calendar', date: '2026-10-30' }).error, 'unauthorized');
});
