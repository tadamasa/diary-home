// 日記ハブ(いまの「日記の記録」スプレッドシート + Apps Script)との自動同期。
// 端末内のIndexedDBが正で、変わった記録だけを送り、ハブで変わったもの(GAS日記で書いた分も含む)だけを受け取る。
// 同じ記録を二か所で直したときは、mtime(最後に書いた時刻)が新しい方を残す。
import * as db from './db.js';

const BATCH = 300; // 1回に送る件数
let dirty = {}; // 未送信: { id: { mtime, deleted } }
let cfg = { url: '', token: '' };
let timer = null;
let running = null;
let saveTimer = null;
let onRemoteChange = () => {};
const listeners = new Set();
export const status = { state: 'off', lastAt: null, error: '', pending: 0 };

function emit() {
  status.pending = Object.keys(dirty).length;
  listeners.forEach(fn => fn(status));
}
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function saveDirty() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.setMeta('syncDirty', dirty), 300);
}

function mark(_name, changes) {
  for (const c of changes) dirty[c.id] = { mtime: c.mtime || Date.now(), deleted: !!c.deleted };
  saveDirty();
  emit();
  schedule();
}

export async function initSync(opts = {}) {
  if (opts.onRemoteChange) onRemoteChange = opts.onRemoteChange;
  const [url, token, saved, lastAt] = await Promise.all([db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''), db.getMeta('syncDirty'), db.getMeta('syncLastAt')]);
  cfg = { url, token };
  if (saved) dirty = saved;
  status.state = url ? 'idle' : 'off';
  status.lastAt = lastAt;
  db.onChange(mark);
  emit();
}

export function enabled() { return !!(cfg.url && cfg.token); }

// 書いてから少し待ってまとめて送る
export function schedule(delay = 4000) {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

async function post(body) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    // text/plain にすると事前確認(CORS preflight)が要らず、Apps Scriptで受けられる
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: cfg.token, ...body }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`日記ハブ HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error('日記ハブの応答を読めませんでした(URLが正しいか、デプロイのアクセスが「全員」か確かめてください)'); }
  if (!data.ok && data.error === 'unauthorized') throw new Error('合言葉が違います');
  return data;
}

// その日の縁泉・読了本など、同期以外の読み取り。圏外なら投げる
export async function ask(action, params = {}) {
  if (!enabled()) throw new Error('設定で日記ハブにつなぐと表示されます');
  if (navigator.onLine === false) throw new Error('オフラインです');
  return post({ action, ...params });
}

// 受け取った記録を手元に書く。手元の未送信のほうが新しければ書かない
export async function apply(items) {
  let changed = 0;
  for (const it of items) {
    const pending = dirty[it.id];
    if (pending && pending.mtime >= it.mtime) continue;
    const local = await db.get('entries', it.id);
    if (local && (local.mtime || 0) > it.mtime) continue;
    if (it.deleted) { if (local) { await db.del('entries', it.id, { silent: true }); changed++; } continue; }
    if (!it.data) continue;
    if (local && (local.mtime || 0) === it.mtime) continue; // 同じもの
    it.data.mtime = it.mtime;
    await db.put('entries', it.data, { silent: true });
    changed++;
  }
  return changed;
}

export function syncNow() {
  if (!enabled()) return Promise.resolve(0);
  if (running) return running;
  running = (async () => {
    status.state = 'syncing'; status.error = ''; emit();
    let changed = 0;
    try {
      let cursor = Number(await db.getMeta('syncCursor', 0)) || 0;
      for (let guard = 0; guard < 100; guard++) {
        const body = { since: cursor, entries: [], newTags: (await db.getMeta('pendingTags', [])) || [] };
        for (const [id, d] of Object.entries(dirty).slice(0, BATCH)) {
          const rec = d.deleted ? null : await db.get('entries', id);
          body.entries.push(rec ? { id, mtime: rec.mtime || d.mtime, data: rec } : { id, mtime: d.mtime, deleted: true });
        }
        const res = await post(body);
        if (!res.ok) throw new Error(`日記ハブ: ${res.error}`);
        // 送っている間に書き直されたものは、次の回に送る
        for (const item of body.entries) if (dirty[item.id] && dirty[item.id].mtime <= item.mtime) delete dirty[item.id];
        if (body.newTags.length) await db.setMeta('pendingTags', []);
        if (res.tags) await db.setMeta('tags', res.tags);
        if (res.prompts) await db.setMeta('prompts', res.prompts);
        changed += await apply(res.entries || []);
        cursor = res.rev;
        await db.setMeta('syncCursor', cursor);
        saveDirty();
        if (!res.more && !Object.keys(dirty).length) break;
      }
      status.lastAt = new Date().toISOString();
      await db.setMeta('syncLastAt', status.lastAt);
      status.state = 'idle';
    } catch (e) {
      status.state = 'error';
      status.error = navigator.onLine === false ? 'オフラインです' : e.message;
    } finally {
      running = null;
      emit();
    }
    if (changed) await onRemoteChange(changed);
    return changed;
  })();
  return running;
}

// 接続: 手元のデータをすべて未送信にして、最初から同期する
export async function connect(url, token) {
  cfg = { url: url.trim(), token: token.trim() };
  await db.setMeta('syncUrl', cfg.url);
  await db.setMeta('syncToken', cfg.token);
  await db.setMeta('syncCursor', 0);
  for (const r of await db.getAll('entries')) dirty[r.id] = { mtime: r.mtime || 1, deleted: false };
  await db.setMeta('syncDirty', dirty);
  status.state = 'idle';
  emit();
  return syncNow();
}

export async function disconnect() {
  cfg = { url: '', token: '' };
  clearTimeout(timer);
  await Promise.all(['syncUrl', 'syncToken', 'syncCursor', 'syncLastAt'].map(k => db.setMeta(k, null)));
  dirty = {};
  await db.setMeta('syncDirty', dirty);
  status.state = 'off'; status.lastAt = null; status.error = '';
  emit();
}
