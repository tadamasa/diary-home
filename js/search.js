// 過去の日記をさがす。画面に触れない計算だけを置く(テストできるように)。
//
// 端末の IndexedDB には日記ハブから全期間の記録が届いているので、検索は端末の中だけで行う(圏外でも使え、何も外へ送らない)。
// 日本語は語の区切りがないので「部分一致」。全角/半角・大文字/小文字・ひらがな/カタカナの違いは無視する。
//   空白で区切ると AND、先頭に - を付けた語は除く、
//   2024 / 2024-05 / 2024年5月 のような語は、その年・月の記録に絞る。
import { splitTags, esc } from './diary.js';

// 1文字ずつ正規化し、正規化後の位置 → 元の位置 の対応も返す(ハイライトを元の文に戻すため)
export function normMap(s) {
  const src = String(s ?? '');
  let out = '';
  const map = [];
  let i = 0;
  for (const ch of src) {
    let n = ch.normalize('NFKC').toLowerCase();
    n = n.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)); // カタカナ → ひらがな
    for (let k = 0; k < n.length; k++) map.push(i);
    out += n;
    i += ch.length;
  }
  map.push(i);
  return { text: out, map };
}

export function norm(s) { return normMap(s).text; }

const p2 = n => String(n).padStart(2, '0');

// 年・月の語 → 'YYYY' / 'YYYY-MM' / 'YYYY-MM-DD'。そうでなければ null
export function datePrefix(term) {
  const t = String(term).normalize('NFKC').trim();
  let m = t.match(/^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/) || t.match(/^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (mo && (Number(mo) < 1 || Number(mo) > 12)) return null;
  return [y, mo && p2(mo), mo && d && p2(d)].filter(Boolean).join('-');
}

// 検索語を { words, nots, dates } に分ける
export function parseQuery(q) {
  const words = [], nots = [], dates = [];
  for (const raw of String(q || '').normalize('NFKC').split(/\s+/).filter(Boolean)) {
    if (raw.length > 1 && raw[0] === '-') { const w = norm(raw.slice(1)); if (w) nots.push(w); continue; }
    const d = datePrefix(raw);
    if (d) { dates.push(d); continue; }
    const w = norm(raw);
    if (w) words.push(w);
  }
  return { words, nots, dates };
}

function ranges(hay, word) {
  const out = [];
  if (!word) return out;
  for (let i = hay.indexOf(word); i >= 0; i = hay.indexOf(word, i + word.length)) out.push([i, i + word.length]);
  return out;
}

// 記録を絞る。返り値: [{ e, hits:[[start,end]...](元の本文の位置), tagHits:Set(当たったタグ名) }]
// opts: { q, feelings: 選んだFeeling(すべて含むものだけ), thinkings: 同, order: 'new' | 'old' }
export function searchEntries(entries, { q = '', feelings = [], thinkings = [], order = 'new' } = {}) {
  const { words, nots, dates } = parseQuery(q);
  const fs = [...feelings], ts = [...thinkings];
  if (!words.length && !nots.length && !dates.length && !fs.length && !ts.length) return [];
  const out = [];
  for (const e of entries) {
    if (!e || !e.date) continue;
    if (dates.length && !dates.some(d => e.date.startsWith(d))) continue;
    const feel = splitTags(e.feelings), think = splitTags(e.thinkings);
    if (fs.some(f => !feel.includes(f)) || ts.some(t => !think.includes(t))) continue;
    const body = normMap(e.text);
    const tagsN = [...feel, ...think].map(t => [t, norm(t)]);
    if (nots.some(w => body.text.includes(w) || tagsN.some(([, n]) => n.includes(w)))) continue;
    let ok = true;
    const hits = [];
    const tagHits = new Set();
    for (const w of words) {
      const r = ranges(body.text, w);
      const tg = tagsN.filter(([, n]) => n.includes(w));
      if (!r.length && !tg.length) { ok = false; break; }
      for (const [a, b] of r) hits.push([body.map[a], body.map[b]]);
      for (const [t] of tg) tagHits.add(t);
    }
    if (!ok) continue;
    hits.sort((x, y) => x[0] - y[0]);
    out.push({ e, hits: merge(hits), tagHits });
  }
  const key = r => `${r.e.date}T${r.e.time || ''}`;
  out.sort((a, b) => order === 'old' ? key(a).localeCompare(key(b)) : key(b).localeCompare(key(a)));
  return out;
}

function merge(rs) {
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  }
  return out;
}

// 本文の抜き出し(HTML)。最初に当たったところの前後を見せ、当たった語は <mark> で囲む。
// 当たりがない(タグだけで当たった)ときは冒頭から
export function snippetHtml(text, hits, width = 90) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  // 空白をまとめたので位置がずれる: 元の文の位置 → まとめた後の位置
  const src = String(text ?? '');
  const pos = [];
  let j = 0, prevSpace = false;
  for (let i = 0; i <= src.length; i++) {
    pos.push(j);
    if (i === src.length) break;
    const sp = /\s/.test(src[i]);
    if (!(sp && prevSpace)) j++;
    prevSpace = sp;
  }
  const hs = hits.map(([a, b]) => [pos[a], pos[b]]);
  const first = hs.length ? hs[0][0] : 0;
  let start = Math.max(0, first - Math.floor(width / 3));
  let end = Math.min(s.length, start + width);
  start = Math.max(0, end - width);
  let html = '';
  let at = start;
  for (const [a, b] of hs) {
    if (b <= start || a >= end) continue;
    const ca = Math.max(a, start), cb = Math.min(b, end);
    html += esc(s.slice(at, ca)) + `<mark>${esc(s.slice(ca, cb))}</mark>`;
    at = cb;
  }
  html += esc(s.slice(at, end));
  return `${start > 0 ? '…' : ''}${html}${end < s.length ? '…' : ''}`;
}

// 当たった記録を年×月に数える: { years: [YYYY 新しい順], cells: { 'YYYY-MM': { n, feelings: [] } } }
export function timeline(results) {
  const cells = {};
  for (const { e } of results) {
    const ym = e.date.slice(0, 7);
    const c = cells[ym] || (cells[ym] = { n: 0, feelings: [] });
    c.n++;
    c.feelings.push(...splitTags(e.feelings));
  }
  const years = [...new Set(Object.keys(cells).map(k => k.slice(0, 4)))].sort().reverse();
  return { years, cells };
}

// 当たった記録に一緒に付いていたFeeling(多い順)。選んで絞り込んだものは除く
export function coFeelings(results, exclude = [], max = 8) {
  const c = {};
  for (const { e } of results) for (const f of new Set(splitTags(e.feelings))) if (!exclude.includes(f)) c[f] = (c[f] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
}

// 画面の状態 ⇔ アドレスの #search/… (戻るボタンや再読み込みで同じ検索に戻れるように)
export function encodeSearch({ q = '', feelings = [], thinkings = [], order = 'new' } = {}) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (feelings.length) p.set('f', [...feelings].join(','));
  if (thinkings.length) p.set('t', [...thinkings].join(','));
  if (order === 'old') p.set('o', 'old');
  return p.toString();
}

export function decodeSearch(s) {
  const p = new URLSearchParams(String(s || ''));
  const list = k => (p.get(k) || '').split(',').map(x => x.trim()).filter(Boolean);
  return { q: p.get('q') || '', feelings: list('f'), thinkings: list('t'), order: p.get('o') === 'old' ? 'old' : 'new' };
}

// 本文全体を、当たった語だけ <mark> で囲んで返す(日付ページで検索から来た記録に使う)
export function markHtml(text, hits) {
  const s = String(text ?? '');
  let html = '', at = 0;
  for (const [a, b] of hits) { html += esc(s.slice(at, a)) + `<mark>${esc(s.slice(a, b))}</mark>`; at = b; }
  return html + esc(s.slice(at));
}
