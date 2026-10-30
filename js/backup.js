// バックアップ: 全データをJSONにして、iPhoneの共有シート(「ファイル」に保存→iCloud Drive等)へ渡す。
import * as db from './db.js';

// キーと、端末ごとの同期の状態は書き出さない
const SECRET_KEYS = new Set(['geminiKey', 'syncUrl', 'syncToken', 'syncCursor', 'syncDirty', 'syncLastAt', 'pendingTags']);

export async function exportData() {
  const [entries, meta] = await Promise.all([db.getAll('entries'), db.getAll('meta')]);
  const payload = {
    app: 'diary-home',
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
    meta: meta.filter(m => !SECRET_KEYS.has(m.key)),
  };
  const name = `diary-home-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch (e) {
      if (e.name === 'AbortError') return false;
      throw e;
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  await db.setMeta('lastBackupAt', new Date().toISOString());
  return true;
}

// 取り込み: idが同じものは mtime が新しい方を残す
export async function importData(text) {
  const data = JSON.parse(text);
  if (data.app !== 'diary-home') throw new Error('このアプリのバックアップファイルではありません');
  const current = new Map((await db.getAll('entries')).map(x => [x.id, x]));
  const toPut = (data.entries || []).filter(x => {
    const cur = current.get(x.id);
    return !cur || (x.mtime || 0) > (cur.mtime || 0);
  });
  await db.putMany('entries', toPut);
  return toPut.length;
}
