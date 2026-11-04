import { findStationsInOrder, normalizeStation } from './stations';
import { toYmd } from './format';
import type { ParsedTicket, Seat, Source } from './types';

/** 全形轉半形、移除中文字之間的空白（Tesseract 常把中文拆開） */
export function normalizeOcrText(text: string): string {
  let s = text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/臺/g, '台');
  const cjk = '[\\u3400-\\u9fff]';
  const re = new RegExp(`(${cjk})[ \\t]+(?=${cjk})`, 'g');
  s = s.replace(re, '$1');
  return s;
}

const digitsAfter = (text: string, label: RegExp, len: number): string => {
  const m = text.match(new RegExp(`${label.source}[^0-9]{0,12}((?:\\d[\\s-]?){${len}})`));
  if (!m) return '';
  const d = m[1].replace(/\D/g, '');
  return d.length === len ? d : '';
};

/** 解析車票（截圖或紙本照片）OCR 文字 */
export function parseTicketText(raw: string, hint: { tallImage?: boolean } = {}): ParsedTicket {
  const text = normalizeOcrText(raw);
  const oneLine = text.replace(/\n/g, ' ');
  const out: ParsedTicket = {};

  // 日期：優先找「日期」標籤後的日期，否則取第一個日期
  const labeled = oneLine.match(/(?:乘車|搭乘|出發|行程)?日期[^0-9]{0,10}(\d{2,4}\s*[/\-.年]\s*\d{1,2}\s*[/\-.月]\s*\d{1,2})/);
  const anyDate = oneLine.match(/((?:20\d{2}|1\d{2})\s*[/\-.年]\s*\d{1,2}\s*[/\-.月]\s*\d{1,2})/);
  const date = toYmd(labeled?.[1]) || toYmd(anyDate?.[1]);
  if (date) out.date = date;

  // 起迄站
  const fromLabel = oneLine.match(/起(?:程)?站[^一-鿿A-Za-z]{0,4}(?:高鐵)?([一-鿿]{2})/);
  const toLabel = oneLine.match(/(?:到達|迄)站[^一-鿿A-Za-z]{0,4}(?:高鐵)?([一-鿿]{2})/);
  const st = findStationsInOrder(oneLine);
  out.dep = normalizeStation(fromLabel?.[1]) || st[0] || '';
  out.arr = normalizeStation(toLabel?.[1]) || st.find((s) => s !== out.dep) || '';
  if (!out.dep) delete out.dep;
  if (!out.arr) delete out.arr;

  // 車票號碼：紙本 03-1-04-0-203-0156 → 13 碼
  const dashed = oneLine.match(/\b(\d{2})\s*-\s*(\d)\s*-\s*(\d{2})\s*-\s*(\d)\s*-\s*(\d{3})\s*-\s*(\d{4})\b/);
  const ticketNo =
    (dashed ? dashed.slice(1).join('') : '') ||
    digitsAfter(oneLine, /(?:車票號碼|票號|卡號\/票號|Ticket\s*No\.?)/, 13) ||
    (oneLine.match(/(?<!\d)(\d{13})(?!\d)/)?.[1] ?? '');
  if (ticketNo) out.ticketNo = ticketNo;

  // 訂位代號
  let booking = digitsAfter(oneLine, /(?:訂位代號|Reservation\s*No\.?)/, 8);
  const isPaper = !!dashed || /NT\s*\$|磁票|變更乙次|旅客聯/.test(oneLine);
  if (!booking && isPaper && !/自由座/.test(oneLine)) {
    // 紙本對號座：一組非日期的 8 碼數字
    const cands = [...oneLine.matchAll(/(?<![\d-])(\d{8})(?![\d-])/g)].map((m) => m[1]);
    booking = cands.find((c) => c !== date && !/^(19|20)\d{6}$/.test(c)) ?? '';
  }
  if (booking) out.bookingCode = booking;

  // 座別
  let seat: Seat = '';
  if (/自由座|Non-?reserved/i.test(oneLine)) seat = 'free';
  else if (/對號座|訂位代號|Reserved/i.test(oneLine) || booking) seat = 'reserved';
  else if (/購票序號/.test(oneLine)) seat = 'free';
  if (seat) out.seat = seat;
  if (seat === 'free') out.bookingCode = '';

  // 來源
  let source: Source = '';
  if (isPaper) source = 'paper';
  else if (/T\s*Express|電子票證|手機|購票序號|行動/i.test(oneLine) || hint.tallImage) source = 'mobile';
  if (source) out.source = source;

  // 金額
  const fareM =
    oneLine.match(/(?:票價|金額|票款|Fare)[^0-9]{0,8}(\d{2,5})/i) ||
    oneLine.match(/NT\s*\$\s*(\d{2,5})/i) ||
    oneLine.match(/\$\s*(\d{2,5})(?!\d)/);
  if (fareM) out.fare = Number(fareM[1]);

  return out;
}

/** OCR 解析品質分數：用來判斷要不要旋轉影像重試 */
export function scoreParsed(p: ParsedTicket): number {
  return (p.date ? 2 : 0) + (p.dep ? 1 : 0) + (p.arr ? 1 : 0) + (p.ticketNo ? 2 : 0) + (p.bookingCode ? 1 : 0) + (p.fare ? 1 : 0);
}

/** 解析高鐵電子車票證明 PDF 內文（手機票證明、紙本交易紀錄兩種版型） */
export function parseProofText(raw: string): ParsedTicket {
  const t = normalizeOcrText(raw).replace(/\s+/g, ' ');
  const out: ParsedTicket = {};
  const tn = digitsAfter(t, /(?:卡號\/票號|車票號碼)/, 13) || (t.match(/(?<!\d)(\d{13})(?!\d)/)?.[1] ?? '');
  if (tn) out.ticketNo = tn;
  const date = toYmd(t.match(/乘車日期\s*:\s*(\d{4}-\d{2}-\d{2})/)?.[1]) ||
    toYmd(t.match(/(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  if (date) out.date = date;
  const dep = normalizeStation(t.match(/起程站\s*:\s*(?:高鐵)?([一-鿿]{2})/)?.[1]);
  const arr = normalizeStation(t.match(/到達站\s*:\s*(?:高鐵)?([一-鿿]{2})/)?.[1]);
  if (dep && arr) {
    out.dep = dep; out.arr = arr;
  } else {
    const it = t.match(/([一-鿿]{2})\s*[A-Za-z]+\s*\d{1,2}:\d{2}\s*-+\s*([一-鿿]{2})/);
    const d2 = normalizeStation(it?.[1]), a2 = normalizeStation(it?.[2]);
    if (d2) out.dep = d2;
    if (a2) out.arr = a2;
  }
  const fare = t.match(/票價\s*:\s*(\d+)/)?.[1] ?? t.match(/NT\$\s*(\d+)/)?.[1];
  if (fare) out.fare = Number(fare);
  if (/手機電子票證/.test(t)) out.source = 'mobile';
  else if (/交易紀錄|Transaction Record/.test(t)) out.source = 'paper';
  const bk = t.match(/(?<![\d/:-])(\d{8})(?![\d/:-])/g)?.find((c) => !/^(19|20)\d{6}$/.test(c) && !tn.includes(c));
  if (bk && out.source === 'paper') out.bookingCode = bk;
  return out;
}
