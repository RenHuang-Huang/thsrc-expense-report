import { parseTicketText, scoreParsed } from './parse';
import { normalizeStation } from './stations';
import { toYmd } from './format';
import type { ParsedTicket, Seat, Source } from './types';

export type OcrProgress = (msg: string) => void;

async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/** 畫到 canvas（可旋轉、縮放到最長邊 maxSide） */
function toCanvas(img: ImageBitmap, rotate: 0 | 90 | 180 | 270, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = document.createElement('canvas');
  const swap = rotate === 90 || rotate === 270;
  c.width = swap ? h : w;
  c.height = swap ? w : h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

// ---------- Tesseract.js ----------
type TWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;
let workerPromise: Promise<TWorker> | null = null;

async function getWorker(progress: OcrProgress): Promise<TWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      progress('載入 OCR 引擎與中文語言資料（第一次約 8MB，之後會快取）…');
      const vendor = (p: string) => new URL(`${import.meta.env.BASE_URL}vendor/tesseract/${p}`, location.href).href;
      return createWorker(['chi_tra', 'eng'], 1, {
        // 全部自架，不依賴外部 CDN
        workerPath: vendor('worker.min.js'),
        corePath: vendor('core'),
        langPath: vendor('lang'),
        logger: (m: { status: string; progress: number }) => {
          if (m.status.includes('loading')) progress(`${m.status} ${Math.round(m.progress * 100)}%`);
        },
      });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

export async function ocrWithTesseract(file: Blob, progress: OcrProgress): Promise<{ parsed: ParsedTicket; text: string }> {
  const img = await loadBitmap(file);
  const worker = await getWorker(progress);
  const tall = img.height / img.width > 1.6;
  let best = { parsed: {} as ParsedTicket, text: '', score: -1 };
  // 紙本票照片常旋轉 90 度：先試原方向，分數不夠再轉
  for (const rot of [0, 90, 270, 180] as const) {
    progress(rot ? `旋轉 ${rot}° 重新辨識…` : '辨識中…');
    const { data } = await worker.recognize(toCanvas(img, rot, 2400));
    const parsed = parseTicketText(data.text, { tallImage: tall && rot === 0 });
    const score = scoreParsed(parsed);
    if (score > best.score) best = { parsed, text: data.text, score };
    if (score >= 6) break;
  }
  img.close();
  return { parsed: best.parsed, text: best.text };
}

// ---------- Claude（使用者自己的 API key，瀏覽器直接呼叫） ----------
export const CLAUDE_MODEL = 'claude-sonnet-5-5';

const PROMPT = `你是台灣高鐵車票辨識助手。請看這張車票影像，依 JSON schema 輸出欄位：
- source：T Express 手機票證 App 畫面輸出 "mobile"；紙本車票／磁票／超商 QR Code 紙票的實體照片輸出 "paper"。
- seat：車廂種類含「對號座」或畫面有「訂位代號」輸出 "reserved"；「自由座」或只有「購票序號」輸出 "free"。
- date：搭乘（出發）日期，格式 YYYYMMDD。取行程的搭乘日期，不是開票日期。
- dep / arr：起站、迄站的中文站名（例：板橋、桃園）。站名可能中英並列，一律輸出中文。
- ticket_no：車票號碼 13 碼純數字。紙本常印成 04-2-10-0-274-0636，請去掉連字號。
- booking_code：訂位代號 8 碼數字；自由座輸出空字串。紙本對號座票上通常有一組 8 碼數字即為訂位代號。
- fare：票價整數（紙本印為 NT$130）；畫面上沒有票價時輸出 0。
紙本票照片的文字可能旋轉 90 度，請一併判讀。看不清楚的欄位輸出空字串，不要猜。`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'seat', 'date', 'dep', 'arr', 'ticket_no', 'booking_code', 'fare'],
  properties: {
    source: { type: 'string', enum: ['mobile', 'paper', ''] },
    seat: { type: 'string', enum: ['reserved', 'free', ''] },
    date: { type: 'string' },
    dep: { type: 'string' },
    arr: { type: 'string' },
    ticket_no: { type: 'string' },
    booking_code: { type: 'string' },
    fare: { type: 'integer' },
  },
} as const;

async function toBase64Jpeg(file: Blob): Promise<string> {
  const img = await loadBitmap(file);
  const c = toCanvas(img, 0, 2000);
  img.close();
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
}

export async function ocrWithClaude(file: Blob, apiKey: string, progress: OcrProgress): Promise<{ parsed: ParsedTicket; text: string }> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  progress('Claude 辨識中…');
  const res = await client.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64Jpeg(file) } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude 拒絕處理這張圖片');
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const j = JSON.parse(text) as Record<string, string | number>;
  const seat = (j.seat as Seat) || '';
  const parsed: ParsedTicket = {
    source: (j.source as Source) || '',
    seat,
    date: toYmd(String(j.date ?? '')),
    dep: normalizeStation(String(j.dep ?? '')),
    arr: normalizeStation(String(j.arr ?? '')),
    ticketNo: String(j.ticket_no ?? '').replace(/\D/g, ''),
    bookingCode: seat === 'free' ? '' : String(j.booking_code ?? '').replace(/\D/g, ''),
  };
  const fare = Number(j.fare);
  if (fare > 0) parsed.fare = fare;
  for (const k of Object.keys(parsed) as (keyof ParsedTicket)[]) if (parsed[k] === '') delete parsed[k];
  return { parsed, text };
}
