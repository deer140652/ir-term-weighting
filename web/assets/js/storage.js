/*
 * storage.js
 * ----------
 * 以 IndexedDB 儲存瀏覽器端的資料（容量遠大於 localStorage 的約 5 MB）：
 *   uploads      —— 使用者匯入的文獻陣列
 *   removedBase  —— 被刪除的基礎語料文獻 id 陣列
 *   w2vModel     —— 重新訓練後的 Word2Vec 模型（{ meta, vectors: Float32Array }）
 *
 * 資料只存在「這台電腦的這個瀏覽器」，不會上傳到任何伺服器。
 * 若瀏覽器不支援 IndexedDB（或被停用），會退回只存在記憶體中，
 * 網站仍可正常使用，只是重新整理後不會保留。
 *
 * 對外公開為 window.IRStorage（所有方法皆回傳 Promise）。
 */
(function (global) {
  "use strict";

  const DB_NAME = "pubmed-ir-lab";
  const STORE = "kv";
  const LEGACY_UPLOAD_KEY = "pubmedIrLab.uploads.v1"; // 舊版存在 localStorage 的上傳文獻

  let dbPromise = null;
  const memory = new Map(); // IndexedDB 無法使用時的後備

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!global.indexedDB) { resolve(null); return; }
      let req;
      try {
        req = global.indexedDB.open(DB_NAME, 1);
      } catch (e) {
        resolve(null); return;
      }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  // 在 IndexedDB 上執行一個請求；無法使用 IndexedDB 時改用 fallback()
  function run(mode, fn, fallback) {
    return open().then((db) => {
      if (!db) return fallback();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    });
  }

  function get(key) {
    return run("readonly", (store) => store.get(key), () => memory.get(key))
      .catch(() => memory.get(key));
  }

  function set(key, value) {
    memory.set(key, value);
    return run("readwrite", (store) => store.put(value, key), () => undefined).catch((e) => {
      console.warn("IndexedDB 寫入失敗：", e);
    });
  }

  function del(key) {
    memory.delete(key);
    return run("readwrite", (store) => store.delete(key), () => undefined).catch(() => {});
  }

  // 舊版（localStorage）上傳資料的一次性搬移
  async function migrateLegacy() {
    let raw = null;
    try { raw = global.localStorage.getItem(LEGACY_UPLOAD_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      const legacy = JSON.parse(raw);
      const current = (await get("uploads")) || [];
      if (Array.isArray(legacy) && legacy.length) {
        const ids = new Set(current.map((d) => d.id));
        await set("uploads", current.concat(legacy.filter((d) => !ids.has(d.id))));
      }
      global.localStorage.removeItem(LEGACY_UPLOAD_KEY);
    } catch (e) {
      console.warn("舊資料搬移失敗：", e);
    }
  }

  async function available() {
    return !!(await open());
  }

  global.IRStorage = { get, set, del, migrateLegacy, available };
})(window);
