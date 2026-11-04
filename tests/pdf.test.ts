import { describe, expect, it, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import createModuleRaw from '@neslinesli93/qpdf-wasm';
import { PDFDocument } from 'pdf-lib';
import { isEncryptedPdf, mergePdfs, qpdfDecrypt, type QpdfInstance } from '../src/pdf';

const createModule = createModuleRaw as unknown as (o: object) => Promise<QpdfInstance>;

let qpdf: QpdfInstance;
const wasm = fileURLToPath(new URL('../node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm', import.meta.url));

async function makeEncrypted(password: string, pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]).drawText(`p${i}`);
  qpdf.FS.writeFile('/plain.pdf', await doc.save());
  expect(qpdf.callMain(['--encrypt', password, 'owner-pw', '128', '--use-aes=y', '--', '/plain.pdf', '/enc.pdf'])).toBe(0);
  return new Uint8Array(qpdf.FS.readFile('/enc.pdf'));
}

beforeAll(async () => {
  qpdf = await createModule({ locateFile: () => wasm, noInitialRun: true, print: () => {}, printErr: () => {} });
});

describe('解密與合併', () => {
  it('密碼 = 搭乘日期；錯誤密碼回傳 null', async () => {
    const enc = await makeEncrypted('20261001', 1);
    expect(await isEncryptedPdf(enc)).toBe(true);
    expect(qpdfDecrypt(qpdf, enc, '20261002')).toBeNull();
    const dec = qpdfDecrypt(qpdf, enc, '20261001');
    expect(dec).not.toBeNull();
    expect(await isEncryptedPdf(dec!)).toBe(false);
  });

  it('合併後無密碼、頁數正確', async () => {
    const a = qpdfDecrypt(qpdf, await makeEncrypted('20261001', 1), '20261001')!;
    const b = qpdfDecrypt(qpdf, await makeEncrypted('20261005', 2), '20261005')!;
    const merged = await mergePdfs([{ bytes: a }, { bytes: b }]);
    expect(await isEncryptedPdf(merged)).toBe(false);
    expect((await PDFDocument.load(merged)).getPageCount()).toBe(3);
  });
});
