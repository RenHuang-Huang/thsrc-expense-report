// 把 OCR / PDF 需要的執行期檔案複製到 public/vendor/，讓網站不依賴外部 CDN。
// 由 npm 的 predev / prebuild / pretest 自動執行。
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => join(root, 'node_modules', p);
const out = (p) => join(root, 'public', 'vendor', p);

const copies = [
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract/core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract/core/tesseract-core-simd-lstm.wasm.js'],
  ['@tesseract.js-data/chi_tra/4.0.0_best_int/chi_tra.traineddata.gz', 'tesseract/lang/chi_tra.traineddata.gz'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz'],
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
];

for (const [from, to] of copies) {
  if (!existsSync(nm(from))) throw new Error(`找不到 ${from}，請先 npm install`);
  mkdirSync(dirname(out(to)), { recursive: true });
  cpSync(nm(from), out(to), { recursive: true });
}
console.log('vendor files copied to public/vendor/');
