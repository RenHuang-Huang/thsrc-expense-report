// 在報帳網頁上執行：把網頁的 postMessage 轉給擴充功能背景程式，並把進度傳回網頁。
(() => {
  const ORIGIN = location.origin;
  const version = chrome.runtime.getManifest().version;

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const msg = e.data;
    if (!msg || msg.source !== 'thsrc-page') return;
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      window.postMessage({ source: 'thsrc-ext', type: 'ack', reqId: msg.reqId, resp: err ? { ok: false, error: err.message } : resp }, ORIGIN);
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.source === 'thsrc-ext') window.postMessage(msg, ORIGIN);
  });

  const hello = () => window.postMessage({ source: 'thsrc-ext', type: 'hello', version }, ORIGIN);
  hello();
  document.addEventListener('DOMContentLoaded', hello);
})();
