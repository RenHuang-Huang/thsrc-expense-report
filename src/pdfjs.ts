import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const VENDOR = `${import.meta.env.BASE_URL}vendor/pdfjs`;
type Doc = pdfjs.PDFDocumentProxy;

async function tryOpen(bytes: Uint8Array, password?: string): Promise<Doc | 'password' | 'error'> {
  try {
    // pdf.js 會轉移 buffer，所以每次傳副本
    return await pdfjs.getDocument({
      data: bytes.slice(), password,
      cMapUrl: `${VENDOR}/cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${VENDOR}/standard_fonts/`,
    }).promise;
  } catch (e) {
    return (e as { name?: string })?.name === 'PasswordException' ? 'password' : 'error';
  }
}

/** 依序嘗試密碼開啟 PDF；回傳成功的密碼（無密碼時為 null） */
export async function openWithPasswords(bytes: Uint8Array, passwords: string[]): Promise<{ doc: Doc; password: string | null } | null> {
  const first = await tryOpen(bytes);
  if (typeof first !== 'string') return { doc: first, password: null };
  if (first === 'error') return null;
  for (const pw of passwords) {
    const r = await tryOpen(bytes, pw);
    if (typeof r !== 'string') return { doc: r, password: pw };
  }
  return null;
}

export async function extractText(doc: Doc): Promise<string> {
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    parts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return parts.join('\n');
}

/** 備援：把每頁畫成 JPEG（解密失敗時用來重建無密碼 PDF） */
export async function renderPages(doc: Doc, scale = 2.5) {
  const out: { data: Uint8Array; type: 'jpeg'; width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.92));
    out.push({ data: new Uint8Array(await blob.arrayBuffer()), type: 'jpeg', width: base.width, height: base.height });
  }
  return out;
}
