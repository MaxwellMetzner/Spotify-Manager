// A Spotify sign-in leaves the page. Keep the open work in this tab until it returns.
const tabKey = 'spotifyManager.loginDraft';
async function transact(mode, operation) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('spotifyManager.loginDrafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode);
      const request = operation(tx.objectStore('drafts'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error('Could not save the playlist for sign-in.'));
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function saveLoginDraft(draft) {
  const key = sessionStorage.getItem(tabKey) || crypto.randomUUID();
  sessionStorage.setItem(tabKey, key);
  await transact('readwrite', (store) => store.put(draft, key));
}
export async function restoreLoginDraft(restore) {
  const key = sessionStorage.getItem(tabKey);
  if (!key) return;
  const draft = await transact('readonly', (store) => store.get(key));
  if (draft) await restore(draft);
  await transact('readwrite', (store) => store.delete(key));
  sessionStorage.removeItem(tabKey);
}
