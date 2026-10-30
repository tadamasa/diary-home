// こころの色・空・月。画面に触れない計算だけを置く。
//
// Feelingタグを、感情の円環モデル(Russell, J. A. 1980. "A circumplex model of affect."
// Journal of Personality and Social Psychology 39(6), 1161–1178)の2軸
//   快(+)/不快(-) = valence、高ぶり(+)/静まり(-) = arousal
// に置き、その角度を色相、原点からの距離を色の濃さにする。
// 一日の色は、その日のFeelingの位置の平均。色は「良い/悪い」の評価ではなく、こころの位置の目印。

export const AFFECT = {
  嬉しい: [0.9, 0.4], 楽しい: [0.8, 0.5], 好き: [0.8, 0.3], 感動: [0.8, 0.6], 感謝: [0.8, 0], 充実: [0.8, 0.1],
  ワクワク: [0.7, 0.8], 満足: [0.7, -0.2], 面白い: [0.6, 0.5], スッキリ: [0.6, -0.1], 穏やか: [0.6, -0.6], 安心: [0.6, -0.5],
  感心: [0.5, 0.3], 挑戦: [0.4, 0.7], 懐かしい: [0.4, -0.3], ドキドキ: [0.2, 0.8], 驚き: [0.1, 0.9], やばい: [0, 0.8], 普通: [0, 0],
  緊張: [-0.3, 0.8], 疲れた: [-0.4, -0.7], 退屈: [-0.4, -0.6], モヤモヤ: [-0.5, 0.2], 心配: [-0.5, 0.4], 不安: [-0.6, 0.5],
  イライラ: [-0.6, 0.7], がっかり: [-0.6, -0.3], 恐れる: [-0.7, 0.6], 後悔: [-0.7, -0.1], 無力感: [-0.7, -0.6],
  怒り: [-0.8, 0.8], 嫌い: [-0.8, 0.2], 悲しい: [-0.8, -0.3], 喪失感: [-0.8, -0.4],
};

// 円環の角度(0°=快、90°=高ぶり、180°=不快、270°=静まり) → 色相
// 快=金、高ぶった快=珊瑚、高ぶった不快=紅、不快=菫、沈んだ不快=藍、静かな快=若草
const ANCHORS = [[0, 46], [60, 18], [120, -18], [180, -85], [240, -135], [300, -200], [360, -314]];
export function hueOf(v, a) {
  let t = Math.atan2(a, v) * 180 / Math.PI;
  if (t < 0) t += 360;
  for (let i = 1; i < ANCHORS.length; i++) {
    const [t0, h0] = ANCHORS[i - 1];
    const [t1, h1] = ANCHORS[i];
    if (t <= t1) return Math.round((((h0 + (h1 - h0) * (t - t0) / (t1 - t0)) % 360) + 360) % 360);
  }
  return 46;
}

// 辞書にないタグ(あとで足したもの)は名前から決まる位置に、淡く置く
function guess(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  const t = (h % 360) * Math.PI / 180;
  return [Math.cos(t) * 0.35, Math.sin(t) * 0.35];
}

// 本人が円の上で動かした位置(設定の「こころの色」)。既定の位置より優先する
let custom = {};
export function setCustomAffect(map) { custom = map || {}; }
export function defaultAffect(name) { return AFFECT[name] || guess(name); }
export function affectOf(name) { return custom[name] || defaultAffect(name); }

// 円の中に収める(半径1)。小数2桁
export function clampAffect(v, a) {
  const r = Math.hypot(v, a);
  const k = r > 1 ? 1 / r : 1;
  return [Math.round(v * k * 100) / 100, Math.round(a * k * 100) / 100];
}

// 複数のFeelingの位置の平均 → { h, r, v, a }。Feelingがなければ null
export function moodOf(feelings) {
  const fs = (feelings || []).filter(Boolean);
  if (!fs.length) return null;
  let v = 0, a = 0;
  for (const f of fs) { const [x, y] = affectOf(f); v += x; a += y; }
  v /= fs.length; a /= fs.length;
  const r = Math.min(1, Math.hypot(v, a));
  return { h: hueOf(v, a), r: Math.round(r * 100) / 100, v, a };
}

// CSSの変数として渡す(濃さはライト/ダークでCSS側が決める)
export function moodStyle(m) { return m ? `--h:${m.h};--r:${m.r}` : ''; }

// 時間帯の空。夜明け・朝・昼・夕・夜
export function skyOf(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 4.5 && h < 7) return 'dawn';
  if (h >= 7 && h < 11) return 'morning';
  if (h >= 11 && h < 16) return 'noon';
  if (h >= 16 && h < 19) return 'dusk';
  return 'night';
}
export const SKY_LABEL = { dawn: '夜明け', morning: '朝', noon: '昼', dusk: '夕べ', night: '夜' };

// 月齢(0〜29.53日)。2000-01-06 18:14 UTC の新月を起点にした平均朔望月での近似(±1日程度)
const SYNODIC = 29.530588853;
export function moonAge(date) {
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const days = (date.getTime() - ref) / 864e5;
  return ((days % SYNODIC) + SYNODIC) % SYNODIC;
}

export function moonName(age) {
  const n = [[1.5, '新月'], [5, '三日月'], [9.5, '上弦の月'], [13.5, '十三夜'], [16, '満月'], [20.5, '寝待月'], [24.5, '下弦の月'], [28, '有明の月'], [30, '新月']];
  return n.find(([lim]) => age < lim)[1];
}

// 月の形(明るい部分)のSVGパス。中心(0,0)、半径 r
export function moonPath(age, r = 10) {
  const p = age / SYNODIC; // 0=新月, .5=満月
  const rx = Math.abs(Math.cos(2 * Math.PI * p)) * r;
  const f = n => Math.round(n * 100) / 100;
  if (p < 0.5) {
    // 右側が光る(満ちていく)。半月より前は内側へ、後は外側へふくらむ
    return `M0,${-r} A${r},${r} 0 0 1 0,${r} A${f(rx)},${r} 0 0 ${p < 0.25 ? 0 : 1} 0,${-r}Z`;
  }
  return `M0,${-r} A${r},${r} 0 0 0 0,${r} A${f(rx)},${r} 0 0 ${p < 0.75 ? 0 : 1} 0,${-r}Z`;
}

// タグの並べ方。color=円をひと回りする順(快→高ぶった快→高ぶった不快→不快→沈んだ不快→静かな快、中心付近は最後)、
// often=よく使う順(同数ならシートの順)、sheet=「タグ管理」シートの順
export function sortTags(list, mode, counts = {}, withColor = true) {
  const idx = new Map(list.map((n, i) => [n, i]));
  const out = [...list];
  if (mode === 'often') return out.sort((x, y) => (counts[y] || 0) - (counts[x] || 0) || idx.get(x) - idx.get(y));
  if (mode === 'color' && withColor) {
    const key = n => {
      const [v, a] = affectOf(n);
      if (Math.hypot(v, a) < 0.15) return 1000;
      const t = Math.atan2(a, v) * 180 / Math.PI;
      return t < 0 ? t + 360 : t;
    };
    return out.sort((x, y) => key(x) - key(y) || idx.get(x) - idx.get(y));
  }
  return out;
}
