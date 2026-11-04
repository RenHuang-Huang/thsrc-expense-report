import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { buildTemplateData, fillDocx } from '../src/template';
import { newTicket } from '../src/types';

const form = { applicant: '王小明', applyDate: '2026/11/04', description: '客戶拜訪', taxId: '12345678', companyName: '範例股份有限公司' };
const tickets = [
  newTicket({ date: '20261005', dep: '桃園', arr: '板橋', fare: 130 }),
  newTicket({ date: '20261001', dep: '板橋', arr: '桃園', fare: 1300 }),
];

const textOf = (docx: Uint8Array) =>
  new PizZip(docx).file('word/document.xml')!.asText().replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '');

describe('Word 模板', () => {
  it('資料：總金額、筆數、清單', () => {
    const d = buildTemplateData(form, tickets);
    expect(d.總金額).toBe('1,430');
    expect(d.筆數).toBe(2);
    expect(d.清單[0]).toMatchObject({ 序號: 1, 日期: '2026/10/01', 起站: '板橋', 迄站: '桃園', 金額: '1,300' });
    expect(d.清單文字).toBe('2026/10/01,板橋,桃園,1,300\n2026/10/05,桃園,板橋,130');
  });

  it('範例模板：單一佔位、表格迴圈、{{清單}} 純文字都正確替換', () => {
    const tpl = readFileSync(new URL('../public/sample-template.docx', import.meta.url));
    const out = textOf(fillDocx(tpl, buildTemplateData(form, tickets)));
    expect(out).not.toContain('{{');
    for (const s of ['王小明', '2026/11/04', '客戶拜訪', '12345678', '範例股份有限公司', '1,430', '2 筆']) {
      expect(out).toContain(s);
    }
    // 表格逐列展開
    expect(out).toContain('1' + '2026/10/01' + '板橋' + '桃園' + '1,300');
    expect(out).toContain('2' + '2026/10/05' + '桃園' + '板橋' + '130');
    // {{清單}} 多行文字
    expect(out).toContain('每行：日期,起站,迄站,金額）2026/10/01,板橋,桃園,1,300\n2026/10/05,桃園,板橋,130');
  });

  it('選填欄位空白時輸出空字串', () => {
    const tpl = readFileSync(new URL('../public/sample-template.docx', import.meta.url));
    const out = textOf(fillDocx(tpl, buildTemplateData({ ...form, taxId: '', companyName: '' }, tickets)));
    expect(out).not.toContain('undefined');
    expect(out).toContain('統一編號：');
  });
});
