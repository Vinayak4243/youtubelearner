(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeRecoveryStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const DB_NAME = 'adaptpractice-recovery';
  const STORE_NAME = 'snapshots';
  let databasePromise;

  function database() {
    if (!root.indexedDB) return Promise.resolve(null);
    if (!databasePromise) {
      databasePromise = new Promise((resolve,reject) => {
        const request = root.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Local recovery storage could not be opened.'));
      });
    }
    return databasePromise;
  }

  async function get(key) {
    const db = await database();
    if (!db) return root.localStorage.getItem(key);
    return new Promise((resolve,reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error('Local recovery data could not be read.'));
    });
  }

  async function set(key, value) {
    const db = await database();
    if (!db) { root.localStorage.setItem(key, value); return; }
    return new Promise((resolve,reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Local recovery data could not be written.'));
      transaction.onabort = () => reject(transaction.error || new Error('Local recovery data write was aborted.'));
    });
  }

  async function remove(key) {
    const db = await database();
    if (!db) { root.localStorage.removeItem(key); return; }
    return new Promise((resolve,reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Local recovery data could not be removed.'));
    });
  }

  return { get, set, remove };
});
