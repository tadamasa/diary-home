// 画面に触れない処理(テストできるように分けてある)

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const p2 = n => String(n).padStart(2, '0');

// 端末の時刻での YYYY-MM-DD と HH:mm
export function today(d = new Date()) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
export function nowTime(d = new Date()) { return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }

export function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

// 「2026年10月30日(木)」
export function dateLabel(s) {
  const [y, m, d] = s.split('-').map(Number);
  const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日(${w})`;
}

// 月のカレンダー: 先頭の空白を null で埋めた日付の配列
export function monthCells(y, m) {
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const cells = Array(first).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${y}-${p2(m)}-${p2(d)}`);
  return cells;
}

export function shiftMonth(y, m, dm) {
  const t = new Date(y, m - 1 + dm, 1);
  return [t.getFullYear(), t.getMonth() + 1];
}

// タグは「,」や「、」で区切られて入っていることがある(GAS日記の古い行)
export function splitTags(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return String(v || '').split(/[,、]/).map(x => x.trim()).filter(Boolean);
}

// その日の記録を新しい時刻から(GAS日記の並びと同じ)
export function entriesOn(entries, date) {
  return entries.filter(e => e.date === date).sort((a, b) => (b.time || '').localeCompare(a.time || ''));
}

// 選べるタグ: タグ管理の一覧 + 選択中だが一覧にないもの
export function tagChoices(list, selected) {
  const out = [...(list || [])];
  for (const s of selected) if (!out.includes(s)) out.push(s);
  return out;
}

const DEFAULT_PROMPTS = {
  'Geminiサジェスト': '以下の日記を解析し、知的なサジェストを200文字程度でMarkdown形式のリンク付きで提供してください。\n{{text}}',
  'Geminiニュース検索': '{{dateStr}} の日本や世界の主要なニュースや社会の出来事を3つ、URLリンクとともに短く簡潔に教えてください。',
};

// 「プロンプト管理」シートの指示文に、日記や日付を差し込む
export function buildPrompt(prompts, name, vars) {
  let s = (prompts && prompts[name]) || DEFAULT_PROMPTS[name] || '';
  for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(v);
  return s;
}

// AIの返答: 文字はエスケープし、Markdownのリンク [文字](https://…) と **太字** だけ生かす
export function renderAnswer(text) {
  let h = esc(text);
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return h.replace(/\n/g, '<br>');
}

// 新しい記録・直した記録を作る(id は端末で採番)
export function makeEntry({ id, datetime, text, feelings, thinkings }, uid) {
  const [date, time] = String(datetime || '').split('T');
  return {
    id: id || uid(),
    date: isDate(date) ? date : today(),
    time: /^\d{2}:\d{2}/.test(time || '') ? time.slice(0, 5) : nowTime(),
    text: String(text || ''),
    feelings: [...feelings],
    thinkings: [...thinkings],
  };
}

// 日付を n 日ずらす(端末の暦で。月末・年末・うるう年をまたいでよい)
export function shiftDay(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return today(new Date(y, m - 1, d + n));
}

// 指の動きが「横のフリック」なら -1(右へ払う=前) / 1(左へ払う=次)、それ以外は 0。
// 縦のスクロールと見分けるため、横が縦の2倍以上・60px以上・0.6秒以内のときだけ
export function swipeDir(dx, dy, ms) {
  if (ms > 600 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return 0;
  return dx < 0 ? 1 : -1;
}

// その日を含む週(日曜はじまり)の7日。月をまたいでよい
export function weekCells(s) {
  const [y, m, d] = s.split('-').map(Number);
  const w = new Date(y, m - 1, d).getDay();
  return Array.from({ length: 7 }, (_, i) => today(new Date(y, m - 1, d - w + i)));
}

// 本文のカーソル位置 [a, z] に1行を差し込む。前後に改行がなければ足す。返すのは新しい本文と差し込んだ後のカーソル位置
export function insertLine(text, [a, z], line) {
  const before = text.slice(0, a), after = text.slice(z);
  const ins = `${before && !before.endsWith('\n') ? '\n' : ''}${line}${after.startsWith('\n') ? '' : '\n'}`;
  return { text: before + ins + after, caret: before.length + ins.length };
}

// 「この日の縁」に出す縁泉の行。縁泉が毎晩追記する作品(source が reading / movie)は、
// 本・映画の欄が読めたときはそちらに任せて出さない(同じ本・映画が2回出ないように)。
// 本・映画の欄が読めなかったときは残す(その日に読んだ・観た事実が消えないように)。
export const WORK_SOURCES = { reading: 'books', movie: 'films' };
export function ensenEventsShown(events, okBy = {}) {
  return (events || []).filter(ev => {
    const side = WORK_SOURCES[String(ev && ev.source || '').trim().toLowerCase()];
    return !side || !okBy[side];
  });
}
