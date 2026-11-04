import './style.css';
import { STATIONS, stationCode } from './stations';
import { buildCsv, missingFields, sortTickets, sumFares, formatMoney, todayString, toYmd, ymdToSlash, type MissingField } from './format';
import { parseProofText } from './parse';
import { newTicket, type ParsedTicket, type Ticket } from './types';
import { buildTemplateData, describeTemplateError, fillDocx, type FormInfo } from './template';
import type { MergeInput, QpdfInstance } from './pdf';
import { base64ToBytes, detectExt, extVersion, onExtMessage, startDownload, type ExtJob } from './ext';

// ---------------- 狀態 ----------------
interface PendingPdf {
  id: string;
  name: string;
  bytes: Uint8Array;
  password: string | null;
  parsed: ParsedTicket;
  locked: boolean; // 打不開（需要密碼）
}

const state = {
  tickets: [] as Ticket[],
  pending: [] as PendingPdf[],
  template: null as { name: string; bytes: ArrayBuffer } | null,
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BASE = import.meta.env.BASE_URL;

// ---------------- 深淺色 ----------------
const themeBtn = $<HTMLButtonElement>('#theme-toggle');
function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(t: 'light' | 'dark') {
  document.documentElement.dataset.theme = t;
  themeBtn.setAttribute('aria-label', t === 'dark' ? '切換成淺色' : '切換成深色');
  themeBtn.title = themeBtn.getAttribute('aria-label')!;
  themeBtn.dataset.mode = t;
}
try {
  const saved = localStorage.getItem('thsrc.theme');
  if (saved === 'light' || saved === 'dark') applyTheme(saved); else applyTheme(currentTheme());
} catch { applyTheme(currentTheme()); }
themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('thsrc.theme', next); } catch { /* ignore */ }
});

// ---------------- 基本資料 ----------------
const formEls = {
  applicant: $<HTMLInputElement>('#f-applicant'),
  applyDate: $<HTMLInputElement>('#f-date'),
  description: $<HTMLTextAreaElement>('#f-desc'),
  taxId: $<HTMLInputElement>('#f-taxid'),
  companyName: $<HTMLInputElement>('#f-company'),
};
formEls.applyDate.value = todayString();

// 記住常用欄位（只存在這台電腦的瀏覽器）
const REMEMBER = ['applicant', 'taxId', 'companyName', 'description'] as const;
for (const k of REMEMBER) {
  try { const v = localStorage.getItem(`thsrc.${k}`); if (v) formEls[k].value = v; } catch { /* 無痕模式 */ }
  formEls[k].addEventListener('input', () => {
    try { localStorage.setItem(`thsrc.${k}`, formEls[k].value.trim()); } catch { /* ignore */ }
  });
}
formEls.taxId.addEventListener('input', () => { renderGuides(); });
formEls.companyName.addEventListener('input', () => { renderGuides(); });
formEls.applicant.addEventListener('input', () => { renderTotals(); });

function getForm(): FormInfo {
  return {
    applicant: formEls.applicant.value.trim(),
    applyDate: formEls.applyDate.value.trim() || todayString(),
    description: formEls.description.value.trim(),
    taxId: formEls.taxId.value.trim(),
    companyName: formEls.companyName.value.trim(),
  };
}

// ---------------- OCR ----------------
const keyInput = $<HTMLInputElement>('#claude-key');
const engineBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-engine]')];
let engine = 'tesseract';
try {
  engine = localStorage.getItem('thsrc.engine') === 'claude' ? 'claude' : 'tesseract';
  keyInput.value = sessionStorage.getItem('thsrc.key') || '';
} catch { /* ignore */ }
function syncEngine() {
  engineBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.engine === engine)));
  $('#claude-key-wrap').hidden = engine !== 'claude';
}
syncEngine();
engineBtns.forEach((b) => b.addEventListener('click', () => {
  engine = b.dataset.engine!;
  syncEngine();
  try { localStorage.setItem('thsrc.engine', engine); } catch { /* ignore */ }
}));
keyInput.addEventListener('change', () => {
  try { sessionStorage.setItem('thsrc.key', keyInput.value.trim()); } catch { /* ignore */ }
});

const ocrStatus = $('#ocr-status');
let ocrQueue: Promise<void> = Promise.resolve();

function handleImages(files: FileList | File[]) {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  const key = keyInput.value.trim();
  if (engine === 'claude' && !key) {
    ocrStatus.innerHTML = '<span class="err">請先填入 Anthropic API key，或改用「本機辨識」。</span>';
    return;
  }
  const rows = list.map((f) => {
    const t = newTicket({ imageName: f.name, imageUrl: URL.createObjectURL(f), note: '等待辨識…' });
    state.tickets.push(t);
    return { t, f };
  });
  renderAll();
  ocrQueue = ocrQueue.then(async () => {
    const { ocrWithClaude, ocrWithTesseract } = await import('./ocr');
    let i = 0;
    for (const { t, f } of rows) {
      i += 1;
      const prefix = `(${i}/${rows.length}) ${f.name}：`;
      const progress = (m: string) => { ocrStatus.textContent = prefix + m; };
      try {
        const { parsed } = engine === 'claude' ? await ocrWithClaude(f, key, progress) : await ocrWithTesseract(f, progress);
        Object.assign(t, parsed);
        if (t.seat === 'free') t.bookingCode = '';
        const notes: string[] = [];
        const miss = missingFields(t);
        if (miss.length) notes.push('請補紅框欄位');
        t.note = notes.join('・');
      } catch (e) {
        t.note = `辨識失敗：${e instanceof Error ? e.message : String(e)}`;
      }
      renderAll();
    }
    const bad = state.tickets.filter((t) => missingFields(t).length).length;
    ocrStatus.innerHTML = `<span class="ok">辨識完成 ${rows.length} 張。</span>${bad ? ` 還有 ${bad} 筆有欄位要補（紅框）。` : ' 請再核對一次。'}`;
  });
}

// ---------------- 明細表 ----------------
const tbody = $('#tickets tbody');

const opt = (v: string, label: string, cur: string) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
const KINDS: [string, string][] = [['mobile|reserved', '手機・對號'], ['mobile|free', '手機・自由'], ['paper|reserved', '紙本・對號'], ['paper|free', '紙本・自由']];
const kindOpts = (t: Ticket) => {
  const cur = t.source && t.seat ? `${t.source}|${t.seat}` : '';
  return opt('', '請選擇', cur) + KINDS.map(([v, l]) => opt(v, l, cur)).join('');
};
const stationOpts = (cur: string) => opt('', '—', cur) + STATIONS.map((s) => opt(s, s, cur)).join('');

// 重繪時會移除正在輸入的欄位，瀏覽器會補發 change 事件（帶舊值）；重繪期間忽略它。
// 使用者輸入的值已經在 input 事件即時寫入，不會遺失。
let rendering = false;

function renderTable() {
  rendering = true;
  try {
    renderTableInner();
  } finally {
    rendering = false;
  }
}

const DL_LABEL: Record<string, [string, string]> = {
  queued: ['排隊中', 'run'], running: ['下載中', 'run'], rejected: ['資料被拒', 'bad'],
  already: ['已被下載過', 'bad'], error: ['下載失敗', 'bad'], saved: ['在下載資料夾', 'bad'],
};
function dlChip(t: Ticket) {
  const [label, cls] = (t.dl && DL_LABEL[t.dl.status]) || ['待下載', 'wait'];
  return `<span class="chip ${cls}">${label}</span>${t.dl?.message ? `<span class="note">${esc(t.dl.message)}</span>` : ''}`;
}
const ICON_X = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_UNDO = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>';

function renderTableInner() {
  tbody.innerHTML = state.tickets.map((t) => {
    const miss = new Set(missingFields(t));
    const bad = (f: MissingField) => (miss.has(f) ? ' bad' : '');
    const label = `${ymdToSlash(t.date) || '日期未填'} ${t.dep}→${t.arr}`;
    return `<tr data-id="${t.id}" class="${miss.size ? 'has-bad' : ''}">
      <td class="w-date" data-label="搭乘日期"><div class="date-cell">
        ${t.imageUrl ? `<img class="thumb" src="${t.imageUrl}" alt="${esc(t.imageName)}" title="點一下放大：${esc(t.imageName)}" data-zoom>` : ''}
        <input data-f="date" class="cell-in mono${bad('date')}" value="${esc(t.date)}" placeholder="YYYYMMDD" inputmode="numeric" aria-label="搭乘日期">
      </div></td>
      <td data-label="區間"><div class="route">
        <select data-f="dep" class="cell-in${bad('dep')}" aria-label="起站">${stationOpts(t.dep)}</select><span class="arrow" aria-hidden="true">→</span>
        <select data-f="arr" class="cell-in${bad('arr')}" aria-label="迄站">${stationOpts(t.arr)}</select>
      </div></td>
      <td class="span-all" data-label="票種"><div class="kind">
        <select data-f="kind" class="cell-in${miss.has('source') || miss.has('seat') ? ' bad' : ''}" aria-label="票種">${kindOpts(t)}</select>
      </div></td>
      <td class="w-no" data-label="車票號碼（13 碼）"><input data-f="ticketNo" class="cell-in mono${bad('ticketNo')}" value="${esc(t.ticketNo)}" inputmode="numeric" placeholder="13 碼" aria-label="車票號碼"></td>
      <td class="w-bk" data-label="訂位代號（8 碼）"><input data-f="bookingCode" class="cell-in mono${bad('bookingCode')}" value="${esc(t.bookingCode)}" inputmode="numeric" ${t.seat === 'free' ? 'disabled placeholder="自由座免填"' : 'placeholder="8 碼"'} aria-label="訂位代號"></td>
      <td class="w-fare num" data-label="金額"><input data-f="fare" class="cell-in mono fare-in${bad('fare')}" type="number" min="0" value="${t.fare ?? ''}" placeholder="證明帶入" aria-label="金額"></td>
      <td data-label="證明 PDF"><div class="pdf-cell">
        ${t.pdf
          ? `<span class="row"><span class="chip ok" title="${esc(t.pdf.name)}">已對應</span><button type="button" class="icon-btn" data-unpdf title="取消對應" aria-label="取消 ${esc(label)} 的 PDF 對應">${ICON_UNDO}</button></span>`
          : dlChip(t)}
        ${t.note ? `<span class="note">${esc(t.note)}</span>` : ''}
      </div></td>
      <td class="del"><button type="button" class="icon-btn" data-del aria-label="刪除 ${esc(label)}">${ICON_X}</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">還沒有車票。上傳截圖或照片、按「手動新增」，也可以直接在下面上傳電子車票證明 PDF。</td></tr>';
}

// ---------------- 摘要與步驟 ----------------
const ICON_OK = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
const ICON_BAD = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';
const ICON_TODO = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/></svg>';

function renderTotals() {
  const n = state.tickets.length;
  const withPdf = state.tickets.filter((t) => t.pdf).length;
  const badRows = state.tickets.filter((t) => missingFields(t).length).length;
  const total = `NT$ ${formatMoney(sumFares(state.tickets))}`;
  const dates = state.tickets.map((t) => t.date).filter((d) => /^\d{8}$/.test(d)).sort();
  const range = dates.length ? `${ymdToSlash(dates[0])}${dates.length > 1 && dates[0] !== dates[dates.length - 1] ? ` – ${ymdToSlash(dates[dates.length - 1]).slice(5)}` : ''}` : '';

  $('#sum-total').textContent = total;
  $('#sum-sub').textContent = n ? `${n} 筆車票${range ? `・${range}` : ''}` : '還沒有車票';
  $('#sum-pdf').textContent = `${withPdf} / ${n}`;
  $('#sum-bar').style.width = n ? `${Math.round((withPdf / n) * 100)}%` : '0';
  $('#mb-total').textContent = total;
  $('#mb-sub').textContent = `${n} 筆・總金額`;
  $('#ticket-count').textContent = `${n} 筆${badRows ? `・${badRows} 筆待補` : ''}`;

  const form = getForm();
  const items: [string, string][] = [
    form.applicant ? ['ok', '報帳資料已填'] : ['todo', '還沒填申請人'],
    !n ? ['todo', '還沒有車票'] : badRows ? ['bad', `${badRows} 筆欄位待補`] : ['ok', '明細都填好了'],
    !n ? ['todo', '還沒有證明 PDF'] : withPdf === n ? ['ok', '證明 PDF 都到齊了'] : ['todo', `${n - withPdf} 張證明還沒下載`],
  ];
  $('#checklist').innerHTML = items.map(([k, txt]) =>
    `<li class="${k}">${k === 'ok' ? ICON_OK : k === 'bad' ? ICON_BAD : ICON_TODO}${esc(txt)}</li>`).join('');

  const done = [!!form.applicant, n > 0 && !badRows, n > 0 && withPdf === n];
  const now = done.indexOf(false) === -1 ? 3 : done.indexOf(false);
  $('#steps').innerHTML = ['報帳資料', '車票辨識', '下載證明', '匯出'].map((label, i) => {
    const cls = i < 3 && done[i] ? 'done' : i === now ? 'now' : '';
    return `<div class="step ${cls}"${i === now ? ' aria-current="step"' : ''}><span class="dot" aria-hidden="true">${cls === 'done' ? '✓' : i + 1}</span>${label}</div>`;
  }).join('');
}

function renderAll() {
  renderTable();
  renderTotals();
  renderGuides();
  renderPending();
  renderAuto();
}

const findTicket = (el: Element) => state.tickets.find((t) => t.id === el.closest('tr')?.getAttribute('data-id'));

function applyField(t: Ticket, f: string, v: string) {
  // 改了資料就清掉上次失敗的狀態，可以再按一次自動下載
  if (t.dl && t.dl.status !== 'running' && t.dl.status !== 'queued' && t.dl.status !== 'ok') t.dl = undefined;
  switch (f) {
    case 'fare': t.fare = v === '' ? null : Number(v); break;
    case 'date': t.date = toYmd(v) || v.replace(/\D/g, ''); break;
    case 'ticketNo': t.ticketNo = v.replace(/\D/g, ''); break;
    case 'bookingCode': t.bookingCode = v.replace(/\D/g, ''); break;
    case 'kind': {
      const [src, seat] = v.split('|');
      t.source = (src || '') as Ticket['source'];
      t.seat = (seat || '') as Ticket['seat'];
      if (t.seat === 'free') t.bookingCode = '';
      break;
    }
    case 'source': t.source = v as Ticket['source']; break;
    case 'seat': t.seat = v as Ticket['seat']; if (t.seat === 'free') t.bookingCode = ''; break;
    case 'dep': t.dep = v; break;
    case 'arr': t.arr = v; break;
  }
}

tbody.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const t = findTicket(el);
  const f = el.dataset.f;
  if (!t || !f || el.tagName !== 'INPUT') return;
  applyField(t, f, el.value);
  // 只更新標紅與總計，避免重繪打斷輸入
  const miss = new Set(missingFields(t));
  const tr = el.closest('tr')!;
  tr.querySelectorAll<HTMLElement>('[data-f]').forEach((x) => {
    const f = x.dataset.f!;
    x.classList.toggle('bad', f === 'kind' ? miss.has('source') || miss.has('seat') : miss.has(f as MissingField));
  });
  tr.classList.toggle('has-bad', miss.size > 0);
  renderTotals();
  renderAuto();
});
tbody.addEventListener('change', (e) => {
  if (rendering) return;
  const el = e.target as HTMLInputElement;
  const t = findTicket(el);
  if (!t || !el.dataset.f) return;
  applyField(t, el.dataset.f, el.value);
  if (el.tagName === 'SELECT') {
    // 下拉選單（座別會影響訂位代號欄）才重繪整張表；文字欄位重繪會打斷下一格的輸入
    renderAll();
    return;
  }
  if (el.dataset.f === 'date') el.value = t.date;
  renderGuides();
  renderPending();
  renderAuto();
});
tbody.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const btn = el.closest<HTMLElement>('[data-del],[data-unpdf]');
  if (el.matches('[data-zoom]')) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<img src="${(el as HTMLImageElement).src}" alt="">`;
    box.onclick = () => box.remove();
    document.body.append(box);
    return;
  }
  const t = findTicket(el);
  if (!t) return;
  if (btn?.matches('[data-del]')) {
    if (t.pdf && !confirm('這筆已經對應了證明 PDF，確定要刪除嗎？（PDF 會移到「未對應」清單）')) return;
    if (t.pdf) state.pending.push({ id: `p${Date.now()}`, name: t.pdf.name, bytes: t.pdf.bytes, password: t.pdf.password, parsed: {}, locked: false });
    state.tickets = state.tickets.filter((x) => x !== t);
    renderAll();
  } else if (btn?.matches('[data-unpdf]') && t.pdf) {
    state.pending.push({ id: `p${Date.now()}`, name: t.pdf.name, bytes: t.pdf.bytes, password: t.pdf.password, parsed: {}, locked: false });
    t.pdf = undefined;
    renderAll();
  }
});
$('#add-row').addEventListener('click', () => {
  state.tickets.push(newTicket());
  renderAll();
});

// ---------------- 下載指引 ----------------
const copyBtn = (k: string, v: string) => (v
  ? `<button type="button" class="copy" data-copy="${esc(v)}" title="點一下複製"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></button>`
  : `<span class="copy missing"><span class="k">${esc(k)}</span><span class="v">未填</span></span>`);
const dash = (ymd: string) => (/^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}` : ymd);
let showAllGuides = false;

function guideCard(t: Ticket): string {
  const form = getForm();
  const kind = `${t.source === 'paper' ? '紙本' : '手機'}・${t.seat === 'free' ? '自由座' : '對號座'}`;
  const route = (x: string) => (x ? `${x}（${stationCode(x)}）` : '');
  let how = '';
  let chips: string[] = [];
  if (t.source === 'paper') {
    const byPnr = t.seat !== 'free' && !!t.bookingCode;
    how = `「磁票／QR Code 紙票」分頁 → ${t.seat === 'free' ? '自由座' : '對號座'}，查詢方式選「${byPnr ? '訂位代號' : '車票號碼'}」，填入（點一下複製）：`;
    chips = [copyBtn('搭乘日期', dash(t.date)), copyBtn('起站', route(t.dep)), copyBtn('迄站', route(t.arr)),
      byPnr ? copyBtn('訂位代號', t.bookingCode) : copyBtn('車票號碼', t.ticketNo)];
  } else if (t.seat === 'free') {
    how = 'T Express → 電子車票證明 → 自由座，填入（點一下複製）：';
    chips = [copyBtn('搭乘日期', dash(t.date)), copyBtn('起站', route(t.dep)), copyBtn('迄站', route(t.arr)), copyBtn('車票號碼', t.ticketNo)];
  } else {
    how = 'T Express → 電子車票證明 → 對號座，填入（點一下複製）：';
    chips = [copyBtn('訂位代號', t.bookingCode), copyBtn('車票號碼', t.ticketNo), copyBtn('搭乘日期', dash(t.date))];
  }
  if (t.source !== 'paper' && (form.taxId || form.companyName)) {
    chips.push(copyBtn('統一編號', form.taxId), copyBtn('營利事業名稱', form.companyName));
  }
  return `<div class="guide">
    <div class="guide-head">
      <div class="guide-title">${esc(ymdToSlash(t.date).slice(5) || '日期未填')} ${esc(t.dep || '?')} → ${esc(t.arr || '?')} <span>${kind}</span></div>
      <span class="chip wait">待下載</span>
    </div>
    <div class="guide-how">${how}</div>
    <div class="copies">${chips.join('')}</div>
  </div>`;
}

function renderGuides() {
  const todo = sortTickets(state.tickets).filter((t) => !t.pdf);
  const done = state.tickets.length - todo.length;
  const shown = showAllGuides ? todo : todo.slice(0, 1);
  const rest = todo.length - shown.length;
  let more = '';
  if (rest > 0) more = `<div class="guide-more"><span>還有 ${rest} 張待下載${done ? `・${done} 張已對應` : ''}</span><button type="button" class="link-btn" data-guides="all">全部展開</button></div>`;
  else if (showAllGuides && todo.length > 1) more = `<div class="guide-more"><span>${todo.length} 張待下載${done ? `・${done} 張已對應` : ''}</span><button type="button" class="link-btn" data-guides="one">收合</button></div>`;
  else if (!todo.length && done) more = `<div class="guide-more"><span>${done} 張證明都已對應</span></div>`;
  $('#guides').innerHTML = shown.map(guideCard).join('') + more;
}
$('#guides').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-guides]');
  if (!b) return;
  showAllGuides = b.dataset.guides === 'all';
  renderGuides();
});
document.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.dataset.copy!);
    const v = el.querySelector('.v')!;
    const old = v.textContent;
    v.textContent = '已複製';
    el.classList.add('done');
    setTimeout(() => { v.textContent = old; el.classList.remove('done'); }, 900);
  } catch { /* 無剪貼簿權限 */ }
});

// ---------------- PDF 上傳與對應 ----------------
const pdfStatus = $('#pdf-status');

function matchTicket(parsed: ParsedTicket, text: string, password: string | null): Ticket | undefined {
  const free = state.tickets.filter((t) => !t.pdf);
  const digits = text.replace(/\D/g, '');
  return (
    free.find((t) => parsed.ticketNo && t.ticketNo === parsed.ticketNo) ||
    free.find((t) => t.ticketNo.length === 13 && digits.includes(t.ticketNo)) ||
    free.find((t) => parsed.bookingCode && t.bookingCode === parsed.bookingCode) ||
    free.find((t) => t.date === (parsed.date || password) && t.dep === parsed.dep && t.arr === parsed.arr)
  );
}

function attach(t: Ticket, pdf: { name: string; bytes: Uint8Array; password: string | null }, parsed: ParsedTicket) {
  t.pdf = pdf;
  const notes: string[] = [];
  if (parsed.fare && parsed.fare !== t.fare) {
    notes.push(t.fare ? `金額依證明更正為 ${parsed.fare}` : '金額由證明帶入');
    t.fare = parsed.fare;
  }
  // 補上 OCR 沒抓到的欄位
  for (const k of ['date', 'dep', 'arr', 'ticketNo', 'bookingCode', 'source'] as const) {
    if (!t[k] && parsed[k]) (t as unknown as Record<string, unknown>)[k] = parsed[k];
  }
  if (!t.seat && t.bookingCode) t.seat = 'reserved';
  t.note = notes.join('・');
}

/** 開啟、解析並對應一個 PDF；回傳是否已對應 */
async function processPdf(name: string, bytes: Uint8Array, extraPasswords: string[] = []): Promise<boolean> {
  const { openWithPasswords, extractText } = await import('./pdfjs');
  const fromName = name.match(/(20\d{6})/)?.[1];
  const pwList = [...new Set([...extraPasswords, fromName, ...state.tickets.map((t) => t.date)]
    .filter((x): x is string => !!x && /^\d{8}$/.test(x)))];
  const opened = await openWithPasswords(bytes, pwList);
  const id = `p${Date.now()}${Math.random().toString(36).slice(2)}`;
  if (!opened) {
    state.pending.push({ id, name, bytes, password: null, parsed: {}, locked: true });
    return false;
  }
  const text = await extractText(opened.doc);
  await opened.doc.destroy();
  const parsed = parseProofText(text);
  if (!parsed.date && opened.password) parsed.date = opened.password;
  const pdf = { name, bytes, password: opened.password };
  const t = matchTicket(parsed, text, opened.password);
  if (t) { attach(t, pdf, parsed); return true; }
  state.pending.push({ id, ...pdf, parsed, locked: false });
  return false;
}

async function handlePdfs(files: FileList | File[]) {
  const list = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!list.length) return;
  pdfStatus.textContent = '讀取 PDF…';
  let ok = 0;
  for (const f of list) {
    try {
      if (await processPdf(f.name, new Uint8Array(await f.arrayBuffer()))) ok += 1;
    } catch (e) {
      pdfStatus.innerHTML = `<span class="err">${esc(f.name)} 讀取失敗：${esc((e as Error).message)}</span>`;
    }
  }
  const left = state.pending.length;
  pdfStatus.innerHTML = `<span class="ok">已對應 ${ok} 個 PDF。</span>${left ? ` 有 ${left} 個沒對上，請在下方處理。` : ''}`;
  renderAll();
}

function renderPending() {
  const box = $('#unmatched');
  if (!state.pending.length && /沒對上/.test(pdfStatus.textContent ?? '')) {
    pdfStatus.innerHTML = '<span class="ok">所有上傳的 PDF 都已對應。</span>';
  }
  const freeRows = state.tickets.filter((t) => !t.pdf);
  box.innerHTML = state.pending.map((p) => {
    const desc = p.locked
      ? '打不開（用明細裡的日期當密碼都不對）。請輸入密碼（搭乘日期 YYYYMMDD）：'
      : `內容：${esc(ymdToSlash(p.parsed.date ?? '') || '?')} ${esc(p.parsed.dep ?? '?')}→${esc(p.parsed.arr ?? '?')} 票號 ${esc(p.parsed.ticketNo ?? '?')} 票價 ${esc(p.parsed.fare ?? '?')}`;
    return `<div class="unmatched" data-pid="${p.id}">
      <span class="name">${esc(p.name)}</span><span class="desc">${desc}</span>
      ${p.locked
        ? '<input data-pw placeholder="YYYYMMDD" inputmode="numeric" aria-label="PDF 密碼"><button type="button" data-unlock class="btn">解開</button>'
        : `<select data-assign aria-label="對應到哪一筆"><option value="">對應到…</option>${freeRows.map((t) => `<option value="${t.id}">#${state.tickets.indexOf(t) + 1} ${esc(ymdToSlash(t.date))} ${esc(t.dep)}→${esc(t.arr)}</option>`).join('')}</select>
           <button type="button" data-newrow class="btn">新增成一筆</button>`}
      <button type="button" class="icon-btn" data-drop aria-label="移除 ${esc(p.name)}">${ICON_X}</button>
    </div>`;
  }).join('');
}

$('#unmatched').addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('button') ?? (e.target as HTMLElement);
  const wrap = el.closest<HTMLElement>('[data-pid]');
  const p = state.pending.find((x) => x.id === wrap?.dataset.pid);
  if (!p || !wrap) return;
  if (el.matches('[data-drop]')) {
    state.pending = state.pending.filter((x) => x !== p);
  } else if (el.matches('[data-newrow]')) {
    const t = newTicket({ ...p.parsed, seat: p.parsed.bookingCode ? 'reserved' : '' });
    attach(t, { name: p.name, bytes: p.bytes, password: p.password }, p.parsed);
    state.tickets.push(t);
    state.pending = state.pending.filter((x) => x !== p);
  } else if (el.matches('[data-unlock]')) {
    const pw = (wrap.querySelector('[data-pw]') as HTMLInputElement).value.replace(/\D/g, '');
    state.pending = state.pending.filter((x) => x !== p);
    const ok = await processPdf(p.name, p.bytes, [pw]);
    pdfStatus.innerHTML = ok ? '<span class="ok">已解開並對應。</span>' : '請確認密碼，或手動指定要對應的明細。';
  } else return;
  renderAll();
});
$('#unmatched').addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement;
  if (!el.matches('[data-assign]') || !el.value) return;
  const p = state.pending.find((x) => x.id === el.closest<HTMLElement>('[data-pid]')?.dataset.pid);
  const t = state.tickets.find((x) => x.id === el.value);
  if (!p || !t) return;
  attach(t, { name: p.name, bytes: p.bytes, password: p.password }, p.parsed);
  state.pending = state.pending.filter((x) => x !== p);
  renderAll();
});

// ---------------- 自動下載（擴充功能） ----------------
let downloading = false;
let extChecked = false;
const EXT_ZIP = `${BASE}thsrc-helper-extension.zip`;
const isDesktopChromium = () => /Chrome|Edg\//.test(navigator.userAgent) && !/Mobile|Android|iPhone|iPad/.test(navigator.userAgent);

/** 需要下載的票：沒有 PDF；已被下載過、被拒（要先改資料）的不算 */
const toDownload = () => state.tickets.filter((t) => !t.pdf && !['already', 'saved', 'rejected'].includes(t.dl?.status ?? ''));

let lastAutoHtml = '';
/** 只有內容真的變了才重繪，避免點按鈕時（輸入框 blur 觸發重繪）按鈕被換掉 */
function setAuto(html: string) {
  if (html === lastAutoHtml) return;
  lastAutoHtml = html;
  $('#auto-box').innerHTML = html;
}

function renderAuto() {
  const ver = extVersion();
  if (!ver) {
    if (!extChecked) { setAuto('<div class="auto-card"><div class="info muted">檢查自動下載功能…</div></div>'); return; }
    setAuto(`<div class="install">
      <div class="auto-card" style="border:none;padding:0">
        <div class="info">
          <div class="title"><span class="dot-off" aria-hidden="true"></span>還沒安裝自動下載擴充功能</div>
          <div class="sub">${isDesktopChromium() ? '只要裝一次。裝好後按一個按鈕，系統就會自動到高鐵網站下載所有證明。' : '自動下載需要電腦版 Chrome 或 Edge。手機請改用下方「手動下載與上傳」。'}</div>
        </div>
      </div>
      ${isDesktopChromium() ? `<ol>
        <li><a href="${EXT_ZIP}" download>下載擴充功能（zip）</a>，解壓縮。</li>
        <li>在網址列輸入 <code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>），打開右上角「開發人員模式」。</li>
        <li>按「載入未封裝項目」，選剛剛解壓縮出來的 <b>thsrc-helper-extension</b> 資料夾。</li>
        <li>回到這個頁面重新整理。</li>
      </ol>
      <div class="row"><a class="btn" href="${EXT_ZIP}" download>下載擴充功能</a><button type="button" class="btn soft" data-copy="chrome://extensions"><span class="k">複製</span><span class="v">chrome://extensions</span></button></div>` : ''}
    </div>`);
    return;
  }
  const todo = toDownload();
  const bad = todo.filter((t) => missingFields(t).length);
  const running = state.tickets.filter((t) => t.dl?.status === 'running' || t.dl?.status === 'queued').length;
  let sub = '';
  if (downloading) sub = `下載中…會跳出高鐵網站視窗，請不要關閉它（還剩 ${running} 張）`;
  else if (!state.tickets.length) sub = '先上傳車票照片。';
  else if (!todo.length) sub = '證明都下載好了。';
  else if (bad.length) sub = `還有 ${bad.length} 筆紅框欄位要補，補好才能下載。`;
  else sub = `會自動到高鐵網站查詢、下載 ${todo.length} 張證明，解密後帶入票價。`;
  setAuto(`<div class="auto-card">
    <div class="info">
      <div class="title"><span class="dot-ok" aria-hidden="true"></span>自動下載已就緒 <span class="muted small">擴充功能 v${esc(ver)}</span></div>
      <div class="sub">${sub}</div>
    </div>
    <button type="button" class="btn primary lg" id="auto-dl" ${downloading || !todo.length || bad.length ? 'disabled' : ''}>
      ${downloading ? '下載中…' : `自動下載 ${todo.length || ''} 張證明`}
    </button>
  </div>`);
}

$('#auto-box').addEventListener('click', async (e) => {
  if (!(e.target as HTMLElement).closest('#auto-dl')) return;
  const todo = toDownload();
  if (!todo.length || downloading) return;
  const form = getForm();
  if (!confirm(`即將自動下載 ${todo.length} 張電子車票證明。\n\n高鐵規定每張只能下載一次，請確認明細正確。\n下載時會跳出高鐵網站視窗，完成後會自動關閉，過程中請不要關閉它。`)) return;
  const jobs: ExtJob[] = todo.map((t) => ({
    id: t.id, source: t.source === 'paper' ? 'paper' : 'mobile', seat: t.seat === 'free' ? 'free' : 'reserved',
    date: t.date, depCode: stationCode(t.dep), arrCode: stationCode(t.arr),
    ticketNo: t.ticketNo, bookingCode: t.bookingCode, taxId: form.taxId, company: form.companyName,
  }));
  downloading = true;
  todo.forEach((t) => { t.dl = { status: 'queued' }; });
  pdfStatus.textContent = '';
  renderAll();
  try {
    await startDownload(jobs);
  } catch (err) {
    downloading = false;
    todo.forEach((t) => { t.dl = undefined; });
    pdfStatus.innerHTML = `<span class="err">${esc((err as Error).message)}</span>`;
    renderAll();
  }
});

/** 擴充功能下載回來的 PDF：用搭乘日期解密、讀出票價並對應到這一筆 */
async function attachDownloaded(t: Ticket, name: string, bytes: Uint8Array) {
  let parsed: ParsedTicket = {};
  let password: string | null = t.date;
  try {
    const { openWithPasswords, extractText } = await import('./pdfjs');
    const opened = await openWithPasswords(bytes, [t.date]);
    if (opened) {
      password = opened.password;
      parsed = parseProofText(await extractText(opened.doc));
      await opened.doc.destroy();
    }
  } catch { /* 讀不到內文也先保留檔案 */ }
  attach(t, { name: name || `${t.date}_${t.ticketNo}.pdf`, bytes, password }, parsed);
}

onExtMessage(async (m) => {
  if (m.type === 'hello') { extChecked = true; renderAuto(); return; }
  if (m.type === 'progress') {
    const t = state.tickets.find((x) => x.id === m.id);
    if (!t) return;
    if (m.status === 'ok' && m.pdfBase64) {
      await attachDownloaded(t, m.filename ?? '', base64ToBytes(m.pdfBase64));
      t.dl = { status: 'ok' };
    } else if (m.status === 'rejected') {
      t.dl = { status: 'rejected', message: '高鐵網站說資料不對，請檢查日期、號碼' };
    } else if (m.status === 'already') {
      t.dl = { status: 'already', message: '這張之前已下載過，請從下載資料夾手動上傳' };
    } else if (m.status === 'saved') {
      t.dl = { status: 'saved', message: `${m.message ?? ''}，請手動上傳` };
    } else {
      t.dl = { status: m.status, message: m.message };
    }
    renderAll();
  } else if (m.type === 'done' || m.type === 'fatal') {
    downloading = false;
    state.tickets.forEach((t) => { if (t.dl?.status === 'queued' || t.dl?.status === 'running') t.dl = { status: 'error', message: '沒有完成' }; });
    const ok = state.tickets.filter((t) => t.dl?.status === 'ok').length;
    const fail = state.tickets.filter((t) => !t.pdf && t.dl && t.dl.status !== 'ok').length;
    pdfStatus.innerHTML = m.type === 'fatal'
      ? `<span class="err">自動下載中斷：${esc(m.message)}</span>`
      : `<span class="ok">自動下載完成 ${ok} 張。</span>${fail ? ` ${fail} 張沒成功，原因寫在明細表裡。` : ' 可以匯出了。'}`;
    if (fail) ($('#manual') as HTMLDetailsElement).open = true;
    renderAll();
  }
});

void detectExt().then(() => { extChecked = true; renderAuto(); });

// ---------------- 模板 ----------------
($('#sample-link') as HTMLAnchorElement).href = `${BASE}sample-template.docx`;
$<HTMLInputElement>('#tpl-input').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  state.template = { name: f.name, bytes: await f.arrayBuffer() };
  renderTemplate();
  (e.target as HTMLInputElement).value = '';
});
$('#tpl-reset').addEventListener('click', () => { state.template = null; renderTemplate(); });
function renderTemplate() {
  $('#tpl-name').textContent = state.template ? state.template.name : '範例模板.docx';
  $('#tpl-sub').textContent = state.template ? '你上傳的模板' : '內建・含全部佔位符';
  $('#tpl-reset').hidden = !state.template;
}

async function getTemplate(): Promise<ArrayBuffer> {
  if (state.template) return state.template.bytes;
  const res = await fetch(`${BASE}sample-template.docx`);
  if (!res.ok) throw new Error('範例模板下載失敗');
  return res.arrayBuffer();
}

// ---------------- 匯出 ----------------
const expStatus = $('#export-status');
const setStatus = (html: string) => { expStatus.innerHTML = html; };

function download(data: Uint8Array | string, name: string, type: string) {
  const blob = new Blob([typeof data === 'string' ? '﻿' + data : (data as BlobPart)], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

const stamp = () => todayString().replace(/\//g, '');
const fileBase = () => `高鐵報帳_${getForm().applicant || '未填姓名'}_${stamp()}`;

function checkReady(needPdf: boolean): string | null {
  if (!state.tickets.length) return '還沒有任何車票資料。';
  const bad = state.tickets.findIndex((t) => missingFields(t).filter((f) => f !== 'source' && f !== 'seat' && f !== 'ticketNo' && f !== 'bookingCode').length);
  if (bad >= 0) return `第 ${bad + 1} 筆的日期、起迄站或金額還沒填好。`;
  const noFare = state.tickets.findIndex((t) => !t.fare);
  if (!needPdf && noFare >= 0) return `第 ${noFare + 1} 筆還沒有金額（會從電子車票證明帶入）。`;
  if (needPdf && !state.tickets.some((t) => t.pdf)) return '還沒有上傳任何電子車票證明 PDF。';
  return null;
}

let qpdfPromise: Promise<QpdfInstance> | null = null;
async function getQpdf(): Promise<QpdfInstance> {
  if (!qpdfPromise) {
    qpdfPromise = (async () => {
      const [{ default: createModule }, { default: wasmUrl }] = await Promise.all([
        import('@neslinesli93/qpdf-wasm'),
        import('@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url'),
      ]);
      return (createModule as unknown as (o: object) => Promise<QpdfInstance>)({
        locateFile: () => wasmUrl, noInitialRun: true, print: () => {}, printErr: () => {},
      });
    })();
    qpdfPromise.catch(() => { qpdfPromise = null; });
  }
  return qpdfPromise;
}

async function coverPages() {
  const { renderCoverPages } = await import('./cover');
  return renderCoverPages(buildTemplateData(getForm(), state.tickets));
}

$('#exp-pdf').addEventListener('click', async () => {
  const err = checkReady(true);
  if (err) return setStatus(`<span class="err">${err}</span>`);
  try {
    setStatus('解密並合併中…');
    const { isEncryptedPdf, mergePdfs, qpdfDecrypt } = await import('./pdf');
    const inputs: MergeInput[] = [];
    if (($('#opt-cover') as HTMLInputElement).checked) inputs.push({ pageImages: await coverPages() });
    const fallback: string[] = [];
    for (const t of sortTickets(state.tickets)) {
      if (!t.pdf) continue;
      let bytes: Uint8Array | null = t.pdf.bytes;
      try {
        if (await isEncryptedPdf(bytes)) {
          bytes = t.pdf.password ? qpdfDecrypt(await getQpdf(), bytes, t.pdf.password) : null;
        }
      } catch { bytes = null; }
      if (bytes) {
        try {
          const { PDFDocument } = await import('pdf-lib');
          await PDFDocument.load(bytes); // 確認 pdf-lib 讀得了
          inputs.push({ bytes });
          continue;
        } catch { /* 改用影像重建 */ }
      }
      // 備援：用 pdf.js 以密碼開啟後逐頁轉成影像
      const { openWithPasswords, renderPages } = await import('./pdfjs');
      const opened = await openWithPasswords(t.pdf.bytes, t.pdf.password ? [t.pdf.password] : []);
      if (!opened) throw new Error(`${t.pdf.name} 打不開`);
      inputs.push({ pageImages: await renderPages(opened.doc) });
      await opened.doc.destroy();
      fallback.push(t.pdf.name);
    }
    const merged = await mergePdfs(inputs);
    download(merged, `電子車票證明_合併_${stamp()}.pdf`, 'application/pdf');
    const missing = state.tickets.filter((t) => !t.pdf).length;
    setStatus(`<span class="ok">已產生合併 PDF（無密碼）。</span>` +
      (missing ? ` 注意：有 ${missing} 筆還沒有證明 PDF，沒有放進去。` : '') +
      (fallback.length ? `\n${fallback.join('、')} 無法直接解密，已改用高解析影像重建。` : ''));
  } catch (e) {
    setStatus(`<span class="err">合併失敗：${esc((e as Error).message)}</span>`);
  }
});

$('#exp-docx').addEventListener('click', async () => {
  const err = checkReady(false);
  if (err) return setStatus(`<span class="err">${err}</span>`);
  if (!getForm().applicant) return setStatus('<span class="err">請先填寫申請人。</span>');
  try {
    const out = fillDocx(await getTemplate(), buildTemplateData(getForm(), state.tickets));
    download(out, `${fileBase()}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    setStatus(`<span class="ok">已產生 Word 檔${state.template ? '' : '（使用範例模板）'}。</span>`);
  } catch (e) {
    setStatus(`<span class="err">套用模板失敗：${esc(describeTemplateError(e))}</span>`);
  }
});

$('#exp-csv').addEventListener('click', () => {
  const err = checkReady(false);
  if (err) return setStatus(`<span class="err">${err}</span>`);
  download(buildCsv(state.tickets), `車票明細_${stamp()}.csv`, 'text/csv;charset=utf-8');
  setStatus('<span class="ok">已產生明細 CSV。</span>');
});

$('#exp-cover').addEventListener('click', async () => {
  const err = checkReady(false);
  if (err) return setStatus(`<span class="err">${err}</span>`);
  try {
    const { mergePdfs } = await import('./pdf');
    download(await mergePdfs([{ pageImages: await coverPages() }], '高鐵報帳單'), `${fileBase()}.pdf`, 'application/pdf');
    setStatus('<span class="ok">已產生報帳單 PDF。</span>');
  } catch (e) {
    setStatus(`<span class="err">產生失敗：${esc((e as Error).message)}</span>`);
  }
});

// ---------------- 拖放 ----------------
function setupDrop(dropSel: string, inputSel: string, handler: (f: FileList) => void) {
  const drop = $(dropSel);
  const input = $<HTMLInputElement>(inputSel);
  input.addEventListener('change', () => { if (input.files) handler(input.files); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer?.files) handler(e.dataTransfer.files);
  });
}
setupDrop('#img-drop', '#img-input', handleImages);
setupDrop('#pdf-drop', '#pdf-input', (f) => { void handlePdfs(f); });

window.addEventListener('beforeunload', (e) => {
  if (state.tickets.some((t) => t.pdf)) e.preventDefault();
});

renderTemplate();
renderAll();
