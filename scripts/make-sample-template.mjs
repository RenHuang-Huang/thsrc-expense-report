// 產生範例 Word 模板 public/sample-template.docx（含全部佔位符與清單表格迴圈）
// 用法：npm run make-template
import PizZip from 'pizzip';
import { writeFileSync } from 'node:fs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rPr = (bold, size) =>
  `<w:rPr><w:rFonts w:ascii="Microsoft JhengHei" w:hAnsi="Microsoft JhengHei" w:eastAsia="Microsoft JhengHei"/>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
const run = (text, { bold = false, size = 24 } = {}) =>
  `<w:r>${rPr(bold, size)}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const p = (runs, { align, after = 120 } = {}) =>
  `<w:p><w:pPr>${align ? `<w:jc w:val="${align}"/>` : ''}<w:spacing w:after="${after}"/></w:pPr>${runs}</w:p>`;
const field = (label, tag) => p(run(`${label}：`, { bold: true }) + run(`{{${tag}}}`));

const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((b) => `<w:${b} w:val="single" w:sz="6" w:space="0" w:color="808080"/>`).join('') + '</w:tblBorders>';
const widths = [900, 2000, 1800, 1800, 1800];
const cell = (text, i, { bold = false, shade = false, align = 'center' } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${shade ? '<w:shd w:val="clear" w:color="auto" w:fill="E7EEF7"/>' : ''}</w:tcPr>${p(run(text, { bold }), { align, after: 0 })}</w:tc>`;
const row = (cells, opts) => `<w:tr>${cells.map((c, i) => cell(c, i, opts?.[i] ?? opts)).join('')}</w:tr>`;

const table =
  `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b)}" w:type="dxa"/>${border}<w:tblLayout w:type="fixed"/></w:tblPr>` +
  `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
  row(['序號', '車票日期', '起站', '迄站', '金額'], { bold: true, shade: true }) +
  row(['{{#清單}}{{序號}}', '{{日期}}', '{{起站}}', '{{迄站}}', '{{金額}}{{/清單}}']) +
  row(['合計', '{{筆數}} 筆', '', '', '{{總金額}}'], { bold: true, shade: true }) +
  '</w:tbl>';

const body =
  p(run('高鐵出差交通費報帳單', { bold: true, size: 36 }), { align: 'center', after: 240 }) +
  field('申請人', '申請人') +
  field('申請日期', '申請日期') +
  field('公司名稱', '公司名稱') +
  field('統一編號', '統一編號') +
  field('出差描述', '出差描述') +
  field('筆數', '筆數') +
  p(run('總金額：', { bold: true }) + run('NT$ {{總金額}} 元')) +
  p(run('車票明細', { bold: true }), { after: 60 }) +
  table +
  p('', { after: 120 }) +
  p(run('明細（純文字，每行：日期,起站,迄站,金額）', { bold: true }), { after: 60 }) +
  p(run('{{清單}}', { size: 20 })) +
  p(run('申請人簽章：____________________　主管核准：____________________'), { after: 0 });

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const zip = new PizZip();
zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file('word/document.xml', documentXml);
const out = new URL('../public/sample-template.docx', import.meta.url);
writeFileSync(out, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('wrote', out.pathname);
