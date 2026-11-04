import type { Ticket } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

/** Date → yyyy/mm/dd */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

export function todayString(now = new Date()): string {
  return formatDate(now);
}

/** 檢查 YYYYMMDD 是否為合法日期 */
export function isValidYmd(ymd: string): boolean {
  if (!/^\d{8}$/.test(ymd)) return false;
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 各種日期寫法 → YYYYMMDD；支援西元、民國年（115/10/01）。無法解析回傳空字串。 */
export function toYmd(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = String(raw).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/^\d{8}$/.test(s)) return isValidYmd(s) ? s : '';
  const m = s.match(/(\d{2,4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})/);
  if (!m) return '';
  let y = +m[1];
  if (y < 1000) y += 1911; // 民國年
  const ymd = `${y}${pad(+m[2])}${pad(+m[3])}`;
  return isValidYmd(ymd) ? ymd : '';
}

/** YYYYMMDD → yyyy/mm/dd */
export function ymdToSlash(ymd: string): string {
  return /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}/${ymd.slice(4, 6)}/${ymd.slice(6, 8)}` : ymd;
}

export function sumFares(tickets: Pick<Ticket, 'fare'>[]): number {
  return tickets.reduce((acc, t) => acc + (Number.isFinite(t.fare) ? Number(t.fare) : 0), 0);
}

export function formatMoney(n: number): string {
  return n.toLocaleString('en-US');
}

/** 依日期、起站排序（不改動原陣列） */
export function sortTickets<T extends Pick<Ticket, 'date' | 'dep'>>(tickets: T[]): T[] {
  return [...tickets].sort((a, b) => a.date.localeCompare(b.date) || a.dep.localeCompare(b.dep));
}

/** 明細 CSV：日期,起,迄,金額 + 總計,,,X（與原本 車票明細.txt 相同格式） */
export function buildCsv(tickets: Ticket[]): string {
  const lines = ['日期,起,迄,金額'];
  for (const t of sortTickets(tickets)) lines.push(`${t.date},${t.dep},${t.arr},${t.fare ?? 0}`);
  lines.push(`總計,,,${sumFares(tickets)}`);
  return lines.join('\n') + '\n';
}

export type MissingField = 'date' | 'dep' | 'arr' | 'ticketNo' | 'bookingCode' | 'fare' | 'source' | 'seat';

/** 回傳缺漏或格式錯誤的欄位，讓 UI 標紅 */
export function missingFields(t: Ticket): MissingField[] {
  const out: MissingField[] = [];
  // 已經有證明 PDF 的票，不需要再查詢，所以類型／座別／號碼不是必填
  const needQuery = !t.pdf;
  if (needQuery && !t.source) out.push('source');
  if (needQuery && !t.seat) out.push('seat');
  if (!isValidYmd(t.date)) out.push('date');
  if (!t.dep) out.push('dep');
  if (!t.arr || t.arr === t.dep) out.push('arr');
  if (needQuery && !/^\d{13}$/.test(t.ticketNo)) out.push('ticketNo');
  if (needQuery && t.seat === 'reserved' && !/^\d{8}$/.test(t.bookingCode)) out.push('bookingCode');
  // 截圖通常沒有票價，會從電子車票證明帶入；有證明後才要求金額
  if (t.pdf && (t.fare == null || !Number.isFinite(t.fare) || t.fare <= 0)) out.push('fare');
  return out;
}
