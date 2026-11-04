// 與「高鐵報帳小幫手 自動下載」擴充功能溝通（透過擴充功能注入的 bridge.js 轉送 postMessage）

export interface ExtJob {
  id: string;
  source: 'mobile' | 'paper';
  seat: 'reserved' | 'free';
  date: string;
  depCode: number | null;
  arrCode: number | null;
  ticketNo: string;
  bookingCode: string;
  taxId: string;
  company: string;
}

export type ExtMessage =
  | { source: 'thsrc-ext'; type: 'hello'; version: string }
  | { source: 'thsrc-ext'; type: 'ack'; reqId: number; resp: { ok: boolean; error?: string; version?: string } }
  | { source: 'thsrc-ext'; type: 'progress'; id: string; status: string; message?: string; pdfBase64?: string; filename?: string }
  | { source: 'thsrc-ext'; type: 'done' }
  | { source: 'thsrc-ext'; type: 'fatal'; message: string };

let version: string | null = null;
const listeners = new Set<(m: ExtMessage) => void>();
const pending = new Map<number, (resp: { ok: boolean; error?: string; version?: string }) => void>();
let seq = 0;

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data as ExtMessage;
  if (!m || m.source !== 'thsrc-ext') return;
  if (m.type === 'hello') version = m.version;
  if (m.type === 'ack') {
    pending.get(m.reqId)?.(m.resp);
    pending.delete(m.reqId);
  }
  listeners.forEach((f) => f(m));
});

export const extVersion = () => version;
export function onExtMessage(f: (m: ExtMessage) => void) { listeners.add(f); }

function request(type: string, payload: object, timeout: number) {
  return new Promise<{ ok: boolean; error?: string; version?: string }>((resolve, reject) => {
    const reqId = ++seq;
    const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('擴充功能沒有回應')); }, timeout);
    pending.set(reqId, (r) => { clearTimeout(timer); resolve(r); });
    window.postMessage({ source: 'thsrc-page', type, reqId, ...payload }, location.origin);
  });
}

export async function detectExt(): Promise<string | null> {
  try {
    const r = await request('ping', {}, 1200);
    if (r.ok && r.version) version = r.version;
  } catch { /* 沒裝 */ }
  return version;
}

export async function startDownload(jobs: ExtJob[]) {
  const r = await request('download', { jobs }, 5000);
  if (!r.ok) throw new Error(r.error || '擴充功能拒絕執行');
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
