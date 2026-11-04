import './style.css';
import { STATIONS, stationCode } from './stations';
import { buildCsv, missingFields, sortTickets, sumFares, formatMoney, todayString, toYmd, ymdToSlash, type MissingField } from './format';
import { parseProofText } from './parse';
import { newTicket, type ParsedTicket, type Ticket } from './types';
import { buildTemplateData, describeTemplateError, fillDocx, type FormInfo } from './template';
import type { MergeInput, QpdfInstance } from './pdf';

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
const REMEMBER = ['applicant', 'taxId', 'companyName'] as const;
for (const k of REMEMBER) {
  try { const v = localStorage.getItem(`thsrc.${k}`); if (v) formEls[k].value = v; } catch { /* 無痕模式 */ }
  formEls[k].addEventListener('change', () => {
    try { localStorage.setItem(`thsrc.${k}`, formEls[k].value.trim()); } catch { /* ignore */ }
  });
}
formEls.taxId.addEventListener('input', () => { renderGuides(); });
formEls.companyName.addEventListener('input', () => { renderGuides(); });

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
const engineSel = $<HTMLSelectElement>('#ocr-engine');
const keyInput = $<HTMLInputElement>('#claude-key');
const defaultFare = $<HTMLInputElement>('#default-fare');
try {
  engineSel.value = localStorage.getItem('thsrc.engine') || 'tesseract';
  keyInput.value = sessionStorage.getItem('thsrc.key') || '';
} catch { /* ignore */ }
const syncEngine = () => { $('#claude-key-wrap').hidden = engineSel.value !== 'claude'; };
syncEngine();
engineSel.addEventListener('change', () => {
  syncEngine();
  try { localStorage.setItem('thsrc.engine', engineSel.value); } catch { /* ignore */ }
});
keyInput.addEventListener('change', () => {
  try { sessionStorage.setItem('thsrc.key', keyInput.value.trim()); } catch { /* ignore */ }
});

const ocrStatus = $('#ocr-status');
let ocrQueue: Promise<void> = Promise.resolve();

function handleImages(files: FileList | File[]) {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  const engine = engineSel.value;
  const key = keyInput.value.trim();
  if (engine === 'claude' && !key) {
    ocrStatus.innerHTML = '<span class="err">請先填入 Anthropic API key，或改用 Tesseract.js。</span>';
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
        if (t.fare == null && Number(defaultFare.value) > 0) {
          t.fare = Number(defaultFare.value);
          notes.push('票價用預設值');
        }
        const miss = missingFields(t);
        if (miss.length) notes.push('請補紅框欄位');
        t.note = notes.join('・');
      } catch (e) {
        t.note = `辨識失敗：${e instanceof Error ? e.message : String(e)}`;
        if (t.fare == null && Number(defaultFare.value) > 0) t.fare = Number(defaultFare.value);
      }
      renderAll();
    }
    const bad = state.tickets.filter((t) => missingFields(t).length).length;
    ocrStatus.innerHTML = `<span class="ok">辨識完成 ${rows.length} 張。</span>${bad ? ` 還有 ${bad} 筆有欄位要補（紅框）。` : ''}`;
  });
}

// ---------------- 明細表 ----------------
const tbody = $('#tickets tbody');

const opt = (v: string, label: string, cur: string) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
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

function renderTableInner() {
  tbody.innerHTML = state.tickets.map((t, i) => {
    const miss = new Set(missingFields(t));
    const bad = (f: MissingField) => (miss.has(f) ? ' bad' : '');
    return `<tr data-id="${t.id}">
      <td>${i + 1}</td>
      <td>${t.imageUrl ? `<img src="${t.imageUrl}" alt="${esc(t.imageName)}" title="${esc(t.imageName)}" data-zoom>` : ''}</td>
      <td><select data-f="source" class="${bad('source')}">${opt('', '—', t.source)}${opt('mobile', '手機', t.source)}${opt('paper', '紙本', t.source)}</select></td>
      <td><select data-f="seat" class="${bad('seat')}">${opt('', '—', t.seat)}${opt('reserved', '對號座', t.seat)}${opt('free', '自由座', t.seat)}</select></td>
      <td class="w-date"><input data-f="date" value="${esc(t.date)}" placeholder="YYYYMMDD" inputmode="numeric" class="${bad('date')}"></td>
      <td class="w-st"><select data-f="dep" class="${bad('dep')}">${stationOpts(t.dep)}</select></td>
      <td class="w-st"><select data-f="arr" class="${bad('arr')}">${stationOpts(t.arr)}</select></td>
      <td class="w-no"><input data-f="ticketNo" value="${esc(t.ticketNo)}" inputmode="numeric" class="${bad('ticketNo')}"></td>
      <td class="w-bk"><input data-f="bookingCode" value="${esc(t.bookingCode)}" inputmode="numeric" ${t.seat === 'free' ? 'disabled placeholder="自由座免填"' : ''} class="${bad('bookingCode')}"></td>
      <td class="w-fare"><input data-f="fare" type="number" min="0" value="${t.fare ?? ''}" class="${bad('fare')}"></td>
      <td>${t.pdf ? `<span class="pdf-ok" title="${esc(t.pdf.name)}">✔ 已對應</span> <button class="icon-btn" data-unpdf title="取消對應">↺</button>` : '<span class="pdf-none">尚未上傳</span>'}
        ${t.note ? `<span class="note">${esc(t.note)}</span>` : ''}</td>
      <td><button class="icon-btn" data-del title="刪除">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="12" class="hint" style="text-align:center;padding:18px">還沒有資料。上傳車票圖片，或按「新增一筆」手動輸入，也可以直接在步驟 4 上傳電子車票證明 PDF。</td></tr>';
}

function renderTotals() {
  const n = state.tickets.length;
  const withPdf = state.tickets.filter((t) => t.pdf).length;
  $('#totals').innerHTML = `共 ${n} 筆・總金額 <b>NT$ ${formatMoney(sumFares(state.tickets))}</b>・證明 PDF ${withPdf}/${n}`;
}

function renderAll() {
  renderTable();
  renderTotals();
  renderGuides();
  renderPending();
}

const findTicket = (el: Element) => state.tickets.find((t) => t.id === el.closest('tr')?.getAttribute('data-id'));

function applyField(t: Ticket, f: string, v: string) {
  switch (f) {
    case 'fare': t.fare = v === '' ? null : Number(v); break;
    case 'date': t.date = toYmd(v) || v.replace(/\D/g, ''); break;
    case 'ticketNo': t.ticketNo = v.replace(/\D/g, ''); break;
    case 'bookingCode': t.bookingCode = v.replace(/\D/g, ''); break;
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
  el.closest('tr')!.querySelectorAll<HTMLElement>('[data-f]').forEach((x) => x.classList.toggle('bad', miss.has(x.dataset.f as MissingField)));
  renderTotals();
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
});
tbody.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
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
  if (el.matches('[data-del]')) {
    if (t.pdf && !confirm('這筆已經對應了證明 PDF，確定要刪除嗎？（PDF 會移到「未對應」清單）')) return;
    if (t.pdf) state.pending.push({ id: `p${Date.now()}`, name: t.pdf.name, bytes: t.pdf.bytes, password: t.pdf.password, parsed: {}, locked: false });
    state.tickets = state.tickets.filter((x) => x !== t);
    renderAll();
  } else if (el.matches('[data-unpdf]') && t.pdf) {
    state.pending.push({ id: `p${Date.now()}`, name: t.pdf.name, bytes: t.pdf.bytes, password: t.pdf.password, parsed: {}, locked: false });
    t.pdf = undefined;
    renderAll();
  }
});
$('#add-row').addEventListener('click', () => {
  state.tickets.push(newTicket({ fare: Number(defaultFare.value) > 0 ? Number(defaultFare.value) : null }));
  renderAll();
});

// ---------------- 下載指引 ----------------
const copy = (v: string) => (v ? `<span class="copy" data-copy="${esc(v)}" title="點一下複製">${esc(v)}</span>` : '<b class="req">（缺）</b>');
const dash = (ymd: string) => (/^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}` : ymd);

function renderGuides() {
  const form = getForm();
  const billing = form.taxId || form.companyName
    ? `<li>查到後在結果頁填入統一編號 ${copy(form.taxId)}、營利事業名稱 ${copy(form.companyName)}，再按該列「下載」→ 確認下載。</li>`
    : '<li>查到後（需要的話填統一編號與營利事業名稱），按該列「下載」→ 確認下載。</li>';
  $('#guides').innerHTML = state.tickets.map((t, i) => {
    const st = `${t.dep || '?'}（${stationCode(t.dep) ?? '?'}）→ ${t.arr || '?'}（${stationCode(t.arr) ?? '?'}）`;
    let steps = '';
    if (t.source === 'paper') {
      const by = t.seat === 'reserved' && t.bookingCode
        ? `查詢方式選「訂位代號」，輸入 ${copy(t.bookingCode)}`
        : `查詢方式選「車票號碼」，輸入 ${copy(t.ticketNo)}`;
      steps = `<li>點「磁票／QR Code 紙票」分頁 → 選「${t.seat === 'free' ? '自由座' : '對號座'}」。</li>
        <li>搭乘日期 ${copy(dash(t.date))}，起訖站 ${esc(st)}，${by}。</li>
        <li>按「開始查詢」→ 該列「下載」（紙本不需統編）。</li>`;
    } else if (t.seat === 'free') {
      steps = `<li>點「T Express」→「電子車票證明」→ 座別選「自由座」。</li>
        <li>搭乘日期 ${copy(dash(t.date))}，搭乘區間 ${esc(st)}，車票號碼 ${copy(t.ticketNo)}。</li>
        <li>按「開始查詢」。</li>${billing}`;
    } else {
      steps = `<li>點「T Express」→「電子車票證明」→ 座別選「對號座」。</li>
        <li>訂位代號 ${copy(t.bookingCode)}，車票號碼 ${copy(t.ticketNo)}，搭乘日期 ${copy(dash(t.date))}。</li>
        <li>按「開始查詢」。</li>${billing}`;
    }
    return `<div class="guide${t.pdf ? ' done' : ''}">
      <h4>#${i + 1} ${esc(ymdToSlash(t.date) || '日期未填')} ${esc(t.dep)}→${esc(t.arr)}・${t.source === 'paper' ? '紙本' : '手機'}${t.seat === 'free' ? '自由座' : '對號座'} ${t.pdf ? '✔ 已上傳 PDF' : ''}</h4>
      ${t.pdf ? '' : `<ol>${steps}</ol>`}
    </div>`;
  }).join('');
}
document.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.dataset.copy!);
    const old = el.textContent; el.textContent = '已複製 ✓';
    setTimeout(() => { el.textContent = old; }, 900);
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
    t.fare = parsed.fare;
    notes.push(`金額依 PDF 更新為 ${parsed.fare}`);
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
      <b>${esc(p.name)}</b><span>${desc}</span>
      ${p.locked
        ? '<input data-pw placeholder="YYYYMMDD" inputmode="numeric"><button data-unlock class="ghost">解開</button>'
        : `<select data-assign><option value="">對應到…</option>${freeRows.map((t) => `<option value="${t.id}">#${state.tickets.indexOf(t) + 1} ${esc(ymdToSlash(t.date))} ${esc(t.dep)}→${esc(t.arr)}</option>`).join('')}</select>
           <button data-newrow class="ghost">新增成一筆</button>`}
      <button class="icon-btn" data-drop title="移除">✕</button>
    </div>`;
  }).join('');
}

$('#unmatched').addEventListener('click', async (e) => {
  const el = e.target as HTMLElement;
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

// ---------------- 模板 ----------------
($('#sample-link') as HTMLAnchorElement).href = `${BASE}sample-template.docx`;
$<HTMLInputElement>('#tpl-input').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  state.template = { name: f.name, bytes: await f.arrayBuffer() };
  $('#tpl-name').textContent = `已選擇：${f.name}（點這裡可更換）`;
});

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

renderAll();
