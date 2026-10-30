// IndexedDB の薄いラッパー。外部ライブラリなしで動かす。
const DB_NAME = 'diary-home';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function getAll(name) {
  return wrap((await store(name)).getAll());
}

export async function get(name, id) {
  return wrap((await store(name)).get(id));
}

// 同期のために、日記の書き込みを知らせる。mtime は同期で新旧を比べる時刻(端末の時計、ミリ秒)。
// 同期で受け取ったデータを書くときは { silent: true } にして、送り返さないようにする。
const SYNCED = new Set(['entries']);
let changeHook = null;
export function onChange(fn) { changeHook = fn; }
function touch(name, values, silent) {
  if (silent || !SYNCED.has(name)) return;
  const now = Date.now();
  for (const v of values) v.mtime = now;
}
function notify(name, changes, silent) {
  if (!silent && changeHook && SYNCED.has(name) && changes.length) changeHook(name, changes);
}

export async function put(name, value, { silent = false } = {}) {
  touch(name, [value], silent);
  const r = await wrap((await store(name, 'readwrite')).put(value));
  notify(name, [{ id: value.id, mtime: value.mtime }], silent);
  return r;
}

export async function del(name, id, { silent = false } = {}) {
  const r = await wrap((await store(name, 'readwrite')).delete(id));
  notify(name, [{ id, mtime: Date.now(), deleted: true }], silent);
  return r;
}

export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

export async function putMany(name, values, { silent = false } = {}) {
  touch(name, values, silent);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of values) s.put(v);
    tx.oncomplete = () => { notify(name, values.map(v => ({ id: v.id, mtime: v.mtime })), silent); resolve(values.length); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function clear(name) {
  return wrap((await store(name, 'readwrite')).clear());
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

// ブラウザにデータを消されにくくする(ホーム画面に追加したPWAでは許可されやすい)
export async function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
