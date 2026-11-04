import { PDFDocument } from 'pdf-lib';

/** qpdf (Emscripten) 模組中用得到的部分 */
export interface QpdfInstance {
  callMain: (args: string[]) => number;
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    unlink: (path: string) => void;
  };
}

export async function isEncryptedPdf(bytes: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.isEncrypted;
}

let n = 0;
/** 用 qpdf (WASM) 以密碼解密；密碼錯誤回傳 null */
export function qpdfDecrypt(qpdf: QpdfInstance, bytes: Uint8Array, password: string): Uint8Array | null {
  n += 1;
  const inp = `/in${n}.pdf`, out = `/out${n}.pdf`;
  qpdf.FS.writeFile(inp, bytes);
  let code: number;
  try {
    code = qpdf.callMain([`--password=${password}`, '--decrypt', inp, out]);
  } catch {
    code = 2;
  }
  let result: Uint8Array | null = null;
  // qpdf 結束碼：0 成功、3 成功但有警告、2 錯誤
  if (code === 0 || code === 3) result = new Uint8Array(qpdf.FS.readFile(out));
  for (const p of [inp, out]) {
    try { qpdf.FS.unlink(p); } catch { /* 檔案不存在 */ }
  }
  return result;
}

export interface MergeInput {
  /** 已解密（或本來就無密碼）的 PDF */
  bytes?: Uint8Array;
  /** 無法用 pdf-lib 處理時，改用逐頁影像（PNG/JPEG）重建 */
  pageImages?: { data: Uint8Array; type: 'png' | 'jpeg'; width: number; height: number }[];
}

/** 依傳入順序合併成一個無密碼 PDF */
export async function mergePdfs(inputs: MergeInput[], title = '電子車票證明合併'): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  merged.setTitle(title);
  merged.setProducer('thsrc-expense-report');
  for (const inp of inputs) {
    if (inp.bytes) {
      const src = await PDFDocument.load(inp.bytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } else if (inp.pageImages) {
      for (const img of inp.pageImages) {
        const emb = img.type === 'png' ? await merged.embedPng(img.data) : await merged.embedJpg(img.data);
        const page = merged.addPage([img.width, img.height]);
        page.drawImage(emb, { x: 0, y: 0, width: img.width, height: img.height });
      }
    }
  }
  return merged.save();
}
