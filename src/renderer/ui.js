export const $ = (id) => document.getElementById(id);

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function readObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function showDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
  return dialog;
}

export function status(id, message = '', error = false) {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle('error', error);
}

export function notify(message, error = false) { status('messages', message, error); }

export async function runWorker(data) {
  const worker = new Worker(new URL('./playlistWorker.js', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.result);
      worker.onerror = (event) => reject(new Error(event.message || 'The playlist operation could not finish.'));
      worker.postMessage(data);
    });
  } finally { worker.terminate(); }
}
