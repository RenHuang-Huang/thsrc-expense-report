// 高鐵報帳小幫手 自動下載：背景程式
// 依網頁送來的車票清單，逐張在高鐵 ptis 網站查詢並下載電子車票證明，
// 用 debugger 的 Fetch 攔截取得 PDF 內容（Chrome 仍會照常存一份到下載資料夾），再傳回網頁。
// 流程與選擇器沿用原本 Playwright 工具（2026-07 實機驗證）。

const PTIS_URL = 'https://ptis.thsrc.com.tw/ptis/index';
const PAGE_ORIGINS = ['https://renhuang-huang.github.io', 'http://localhost', 'http://127.0.0.1'];
const NAV_TIMEOUT = 45000;
const PDF_TIMEOUT = 45000;

let running = false;
let capture = null; // { resolve } 等待目前這張的 PDF
const savedDownloads = []; // chrome 存到下載資料夾的檔名（備援）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allowedSender = (sender) => {
  try {
    const u = new URL(sender.url || sender.tab?.url || '');
    return PAGE_ORIGINS.some((o) => u.origin === o || u.origin.startsWith(o + ':'));
  } catch { return false; }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== 'thsrc-page' || !allowedSender(sender)) return;
  if (msg.type === 'ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version, busy: running });
    return;
  }
  if (msg.type === 'download') {
    if (running) { sendResponse({ ok: false, error: '正在下載中，請等目前這批完成。' }); return; }
    const jobs = (msg.jobs || []).map(sanitizeJob);
    const bad = jobs.find((j) => j.error);
    if (bad) { sendResponse({ ok: false, error: bad.error }); return; }
    sendResponse({ ok: true });
    runJobs(jobs, sender.tab.id);
  }
});

// 只接受格式正確的資料，避免任何字串被插進頁面腳本或選擇器
function sanitizeJob(j) {
  const d = (v) => String(v ?? '').replace(/\D/g, '');
  const job = {
    id: String(j.id ?? '').slice(0, 40),
    source: j.source === 'paper' ? 'paper' : 'mobile',
    seat: j.seat === 'free' ? 'free' : 'reserved',
    date: d(j.date),
    depCode: d(j.depCode),
    arrCode: d(j.arrCode),
    ticketNo: d(j.ticketNo),
    bookingCode: d(j.bookingCode),
    taxId: d(j.taxId).slice(0, 8),
    company: String(j.company ?? '').slice(0, 60),
  };
  if (!/^\d{8}$/.test(job.date)) job.error = '搭乘日期格式不對';
  else if (!/^\d{13}$/.test(job.ticketNo)) job.error = '車票號碼要 13 碼';
  else if (job.seat === 'reserved' && !/^\d{8}$/.test(job.bookingCode) && job.source === 'mobile') job.error = '對號座要有 8 碼訂位代號';
  else if ((job.seat === 'free' || job.source === 'paper') && !(+job.depCode >= 1 && +job.depCode <= 12 && +job.arrCode >= 1 && +job.arrCode <= 12)) job.error = '起訖站不對';
  return job;
}

function report(pageTabId, data) {
  chrome.tabs.sendMessage(pageTabId, { source: 'thsrc-ext', ...data }).catch(() => {});
}

// ---------- 攔截 PDF ----------
chrome.debugger.onEvent.addListener(async (src, method, params) => {
  if (method !== 'Fetch.requestPaused') return;
  const { requestId, responseHeaders = [], responseStatusCode = 0 } = params;
  try {
    const h = {};
    for (const x of responseHeaders) h[x.name.toLowerCase()] = x.value;
    const type = h['content-type'] || '';
    const disp = h['content-disposition'] || '';
    const looksPdf = /pdf/i.test(type) || /\.pdf/i.test(disp) || (/octet-stream/i.test(type) && /attachment/i.test(disp));
    if (looksPdf && responseStatusCode < 400) {
      const body = await chrome.debugger.sendCommand(src, 'Fetch.getResponseBody', { requestId });
      const b64 = body.base64Encoded ? body.body : btoa(body.body);
      const m = disp.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
      let name = 'thsrc.pdf';
      if (m) { try { name = decodeURIComponent(m[1] || m[2]); } catch { name = m[1] || m[2]; } }
      // 確認真的是 PDF
      if (atob(b64.slice(0, 8)).startsWith('%PDF')) capture?.resolve({ b64, name });
    }
  } catch (e) {
    console.warn('capture failed', e);
  } finally {
    chrome.debugger.sendCommand(src, 'Fetch.continueRequest', { requestId }).catch(() => {});
  }
});

chrome.downloads.onChanged.addListener((d) => {
  if (!running || d.state?.current !== 'complete') return;
  chrome.downloads.search({ id: d.id }, ([item]) => {
    if (item && /thsrc/i.test(item.url + item.referrer)) savedDownloads.push(item.filename);
  });
});

function waitForPdf(timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { capture = null; resolve(null); }, timeout);
    capture = { resolve: (v) => { clearTimeout(timer); capture = null; resolve(v); } };
  });
}

// ---------- 分頁控制 ----------
function waitForUrl(tabId, re, timeout = NAV_TIMEOUT) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); resolve(ok); };
    const onUpd = (id, info, tab) => {
      if (id === tabId && info.status === 'complete' && re.test(tab.url || '')) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeout);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete' && re.test(t.url || '')) finish(true); }).catch(() => finish(false));
  });
}

async function exec(tabId, func, ...args) {
  // 先把共用函式裝到頁面上（每次換頁都要重裝），再執行這一步
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: installHelpers });
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return res?.result;
}

// ---------- 在高鐵頁面上執行的函式（MAIN world，必須自給自足） ----------
function installHelpers() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const waitFor = async (sel, t = 15000) => {
    const end = Date.now() + t;
    while (Date.now() < end) {
      const all = [...document.querySelectorAll(sel)];
      const el = all.find(visible) || all[0];
      if (el) return el;
      await sleep(200);
    }
    throw new Error('高鐵網頁找不到 ' + sel + '（網站可能改版）');
  };
  const setVal = (el, v) => {
    el.focus?.();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.jQuery) window.jQuery(el).trigger('change');
    el.blur?.();
  };
  // 日期一定要用 jQuery datepicker setDate；直接改 value 表單讀不到
  const setDate = (sel, ymd) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('找不到日期欄位 ' + sel);
    const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
    if (window.jQuery && window.jQuery(el).datepicker) {
      window.jQuery(el).datepicker('setDate', new Date(y, m - 1, d));
      window.jQuery(el).trigger('change');
    } else {
      el.removeAttribute('readonly');
      setVal(el, `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  };
  const visibleText = (txt) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (w.currentNode.nodeValue.includes(txt) && visible(w.currentNode.parentElement)) return true;
    return false;
  };
  window.__thsrcHelper = { sleep, visible, waitFor, setVal, setDate, visibleText };
}

async function fillMobile(job) {
  const { sleep, waitFor, setVal, setDate } = window.__thsrcHelper;
  (await waitFor('#btn_x1')).click();
  await sleep(700);
  (await waitFor('a.tx_btn2')).click();
  await sleep(700);
  setVal(await waitFor('#carClassTypeProof'), job.seat === 'reserved' ? 'res' : 'free');
  await sleep(500);
  if (job.seat === 'reserved') {
    setVal(await waitFor('#txProofPnr'), job.bookingCode);
    setVal(await waitFor("#fr3 input[name='tid']"), job.ticketNo);
    setDate('#goTravelDate', job.date);
  } else {
    setDate('#txFreeDateProof', job.date);
    setVal(await waitFor('#fr4 #txFreeDepStation'), job.depCode);
    setVal(await waitFor('#fr4 #txFreeArrStation'), job.arrCode);
    setVal(await waitFor("#fr4 input[name='txFreeTid']"), job.ticketNo);
  }
  await sleep(600);
  const btn = await waitFor('#tx2 a#sent_btn');
  setTimeout(() => btn.click(), 50); // 先回傳，再送出（送出會換頁）
  return 'submitted';
}

async function fillPaper(job) {
  const { sleep, waitFor, setVal, setDate } = window.__thsrcHelper;
  (await waitFor('#btn_x3')).click();
  await sleep(700);
  (await waitFor(job.seat === 'reserved' ? '#c1_btn' : '#c2_btn')).click();
  await sleep(400);
  setDate('#depDate', job.date);
  setVal(await waitFor('#depStation'), job.depCode);
  setVal(await waitFor('#arrStation'), job.arrCode);
  if (job.seat === 'reserved' && job.bookingCode) {
    setVal(await waitFor('#ticketType'), 'pnrQuery');
    await sleep(200);
    setVal(await waitFor('#tix'), job.bookingCode);
  } else {
    setVal(await waitFor('#ticketType'), 'tidQuery');
    await sleep(200);
    setVal(await waitFor('#tix'), job.ticketNo);
  }
  await sleep(600);
  const btn = await waitFor('#thsrc a#sent_btn');
  setTimeout(() => btn.click(), 50);
  return 'submitted';
}

async function resultMobile(job) {
  const { sleep, waitFor, setVal, visibleText } = window.__thsrcHelper;
  const end = Date.now() + 15000;
  let row = null;
  while (Date.now() < end) {
    if (visibleText('請確認票卡資料正確性')) return { status: 'rejected' };
    row = [...document.querySelectorAll('tr')].find((tr) => tr.innerText.includes(job.ticketNo));
    if (row) break;
    await sleep(300);
  }
  if (!row) return { status: 'error', message: '結果頁找不到這張票' };
  if (row.innerText.includes('已下載')) return { status: 'already' };
  if (job.taxId) { const el = document.querySelector('#iUniNumber'); if (el) setVal(el, job.taxId); }
  if (job.company) { const el = document.querySelector('#iBuyer'); if (el) setVal(el, job.company); }
  await sleep(400);
  const btn = document.querySelector(`a.download_btn[onclick*='${job.ticketNo}']`) || row.querySelector('a.download_btn') || document.querySelector('a.download_btn');
  if (!btn) return { status: 'error', message: '找不到下載按鈕' };
  btn.click();
  const ok = await waitFor('#x2_btn', 10000);
  await sleep(400);
  setTimeout(() => ok.click(), 50); // 「下載」：用掉唯一下載機會
  return { status: 'clicked' };
}

async function resultPaper(job) {
  const { sleep, visibleText } = window.__thsrcHelper;
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (visibleText('請確認票卡資料正確性')) return { status: 'rejected' };
    const btn = document.querySelector('a.download_btn');
    if (btn) {
      const row = btn.closest('tr');
      if (row && row.innerText.includes('已下載')) return { status: 'already' };
      await sleep(300);
      setTimeout(() => btn.click(), 50);
      return { status: 'clicked' };
    }
    await sleep(300);
  }
  return { status: 'error', message: '結果頁找不到下載按鈕' };
}

async function pageError(tabId) {
  return exec(tabId, () => {
    const msgs = [...document.querySelectorAll('.alert, .error, .modal, [role=alert], .swal2-popup, .ui-dialog')]
      .filter((el) => el.getClientRects().length)
      .map((el) => el.innerText.trim()).filter(Boolean);
    return msgs.join(' ').slice(0, 200);
  }).catch(() => '');
}

// ---------- 一張 ----------
async function runOne(tabId, job, progress) {
  await chrome.tabs.update(tabId, { url: PTIS_URL });
  if (!(await waitForUrl(tabId, /\/ptis\/index/i))) throw new Error('高鐵網站沒有回應');
  await sleep(800);
  progress('填寫查詢資料…');
  const paper = job.source === 'paper';
  await exec(tabId, paper ? fillPaper : fillMobile, job);
  progress('查詢中…');
  const okNav = await waitForUrl(tabId, paper ? /TicketInfoQuery/i : /webETSrequest/i);
  if (!okNav) {
    const msg = await pageError(tabId);
    throw new Error(msg ? `高鐵網站：${msg}` : '查詢沒有送出（可能被 reCAPTCHA 擋下，請在跳出的視窗手動按一次「開始查詢」後再試）');
  }
  await sleep(800);
  const pdfPromise = waitForPdf(PDF_TIMEOUT);
  const before = savedDownloads.length;
  const r = await exec(tabId, paper ? resultPaper : resultMobile, job);
  if (r?.status !== 'clicked') { capture = null; return r || { status: 'error', message: '結果頁沒有回應' }; }
  progress('下載中…');
  const pdf = await pdfPromise;
  if (pdf) return { status: 'ok', pdfBase64: pdf.b64, filename: pdf.name };
  await sleep(1500);
  const saved = savedDownloads.slice(before)[0];
  return saved
    ? { status: 'saved', message: `已存到下載資料夾：${saved.split(/[\\/]/).pop()}`, filename: saved }
    : { status: 'error', message: '等不到 PDF' };
}

// ---------- 整批 ----------
async function runJobs(jobs, pageTabId) {
  running = true;
  let win = null;
  let tabId = null;
  let attached = false;
  try {
    win = await chrome.windows.create({ url: PTIS_URL, focused: true, width: 1100, height: 900 });
    tabId = win.tabs[0].id;
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [{ urlPattern: 'https://ptis.thsrc.com.tw/*', requestStage: 'Response' }],
    });
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const progress = (message) => report(pageTabId, { type: 'progress', id: job.id, status: 'running', message: `(${i + 1}/${jobs.length}) ${message}` });
      progress('開啟高鐵網站…');
      try {
        const r = await runOne(tabId, job, progress);
        report(pageTabId, { type: 'progress', id: job.id, ...r });
      } catch (e) {
        report(pageTabId, { type: 'progress', id: job.id, status: 'error', message: String(e?.message || e) });
      }
      await sleep(1000);
    }
  } catch (e) {
    report(pageTabId, { type: 'fatal', message: String(e?.message || e) });
  } finally {
    running = false;
    capture = null;
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    if (win) await chrome.windows.remove(win.id).catch(() => {});
    report(pageTabId, { type: 'done' });
  }
}

chrome.debugger.onDetach.addListener((src, reason) => {
  if (reason === 'canceled_by_user') capture?.resolve(null);
});
