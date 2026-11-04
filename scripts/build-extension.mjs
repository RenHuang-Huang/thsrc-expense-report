// 把 extension/ 打包成 public/thsrc-helper-extension.zip，讓網頁提供下載。
import PizZip from 'pizzip';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'extension');
const zip = new PizZip();
for (const f of readdirSync(src)) zip.file(`thsrc-helper-extension/${f}`, readFileSync(join(src, f)));
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public', 'thsrc-helper-extension.zip'), zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('extension packed to public/thsrc-helper-extension.zip');
