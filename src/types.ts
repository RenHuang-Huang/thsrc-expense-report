export type Source = 'mobile' | 'paper' | '';
export type Seat = 'reserved' | 'free' | '';

export interface Ticket {
  id: string;
  source: Source;
  seat: Seat;
  /** 搭乘日期 YYYYMMDD，也是 PDF 開啟密碼 */
  date: string;
  dep: string;
  arr: string;
  /** 車票號碼 13 碼 */
  ticketNo: string;
  /** 訂位代號 8 碼，自由座為空 */
  bookingCode: string;
  fare: number | null;
  /** 來源圖片檔名 */
  imageName?: string;
  imageUrl?: string;
  /** 對應到的電子車票證明 PDF */
  pdf?: { name: string; bytes: Uint8Array; password: string | null };
  /** OCR 時的提示 */
  note?: string;
  /** 自動下載狀態 */
  dl?: { status: string; message?: string };
}

/** OCR / PDF 解析出來的部分欄位 */
export type ParsedTicket = Partial<Omit<Ticket, 'id' | 'pdf' | 'imageUrl'>>;

let seq = 0;
export function newTicket(p: ParsedTicket & { imageUrl?: string } = {}): Ticket {
  seq += 1;
  return {
    id: `t${Date.now().toString(36)}${seq}`,
    source: '', seat: '', date: '', dep: '', arr: '',
    ticketNo: '', bookingCode: '', fare: null,
    ...p,
  };
}
