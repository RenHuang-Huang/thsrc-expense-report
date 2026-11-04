import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import type { Ticket } from './types';
import { formatMoney, sortTickets, sumFares, ymdToSlash } from './format';

export interface FormInfo {
  applicant: string;
  applyDate: string;
  description: string;
  taxId: string;
  companyName: string;
}

export interface ListItem {
  序號: number;
  日期: string;
  起站: string;
  迄站: string;
  金額: string;
  車票號碼: string;
  訂位代號: string;
}

export interface TemplateData {
  申請人: string;
  申請日期: string;
  出差描述: string;
  統一編號: string;
  公司名稱: string;
  總金額: string;
  筆數: number;
  清單: ListItem[];
  /** {{清單}} 單獨使用時輸出的多行文字 */
  清單文字: string;
}

export function buildTemplateData(form: FormInfo, tickets: Ticket[]): TemplateData {
  const sorted = sortTickets(tickets);
  const list: ListItem[] = sorted.map((t, i) => ({
    序號: i + 1,
    日期: ymdToSlash(t.date),
    起站: t.dep,
    迄站: t.arr,
    金額: formatMoney(t.fare ?? 0),
    車票號碼: t.ticketNo,
    訂位代號: t.bookingCode,
  }));
  return {
    申請人: form.applicant,
    申請日期: form.applyDate,
    出差描述: form.description,
    統一編號: form.taxId,
    公司名稱: form.companyName,
    總金額: formatMoney(sumFares(tickets)),
    筆數: tickets.length,
    清單: list,
    清單文字: list.map((r) => `${r.日期},${r.起站},${r.迄站},${r.金額}`).join('\n'),
  };
}

interface ParserContext {
  meta?: { part?: { module?: string } };
}

/**
 * 把資料套進 .docx 模板。佔位符為 {{名稱}}。
 * {{清單}} 單獨使用 → 多行文字；{{#清單}}…{{/清單}} → 逐筆展開（可放在表格列）。
 */
export function fillDocx(template: ArrayBuffer | Uint8Array, data: TemplateData): Uint8Array {
  const zip = new PizZip(template);
  const doc = new Docxtemplater(zip, {
    delimiters: { start: '{{', end: '}}' },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
    parser: (tag: string) => {
      const key = tag.trim();
      return {
        get(scope: Record<string, unknown>, context: ParserContext) {
          if (key === '.') return scope;
          if (key === '清單' && context?.meta?.part?.module !== 'loop') return data.清單文字;
          return scope?.[key];
        },
      };
    },
  });
  doc.render(data);
  return doc.getZip().generate({ type: 'uint8array', compression: 'DEFLATE' }) as Uint8Array;
}

/** 把 docxtemplater 的錯誤整理成看得懂的訊息 */
export function describeTemplateError(e: unknown): string {
  const err = e as { properties?: { errors?: { properties?: { explanation?: string } }[] }; message?: string };
  const list = err?.properties?.errors?.map((x) => x.properties?.explanation).filter(Boolean);
  if (list && list.length) return list.join('\n');
  return err?.message ?? String(e);
}
