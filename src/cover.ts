import type { TemplateData } from './template';

const FONT = '"Noto Sans TC","Microsoft JhengHei","PingFang TC","Heiti TC",sans-serif';
const W = 595.28, H = 841.89; // A4 (pt)
const S = 2.5; // 解析度倍數
const ROWS_PER_PAGE = 26;

/** 用 canvas 畫報帳單（中文字用系統字型，免嵌入字型檔），回傳每頁 PNG */
export async function renderCoverPages(d: TemplateData): Promise<{ data: Uint8Array; type: 'png'; width: number; height: number }[]> {
  const chunks: typeof d.清單[] = [];
  for (let i = 0; i < Math.max(1, d.清單.length); i += ROWS_PER_PAGE) chunks.push(d.清單.slice(i, i + ROWS_PER_PAGE));
  const pages = [];
  for (let pi = 0; pi < chunks.length; pi++) {
    const c = document.createElement('canvas');
    c.width = W * S; c.height = H * S;
    const g = c.getContext('2d')!;
    g.scale(S, S);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#111'; g.textBaseline = 'middle';
    const text = (t: string, x: number, y: number, size = 11, bold = false, align: CanvasTextAlign = 'left') => {
      g.font = `${bold ? 700 : 400} ${size}px ${FONT}`; g.textAlign = align; g.fillText(t, x, y);
    };
    const L = 56, R = W - 56;
    let y = 64;
    text('高鐵出差交通費報帳單', W / 2, y, 20, true, 'center');
    y += 40;
    if (pi === 0) {
      const fields: [string, string][] = [
        ['申請人', d.申請人], ['申請日期', d.申請日期],
        ['公司名稱', d.公司名稱], ['統一編號', d.統一編號],
        ['筆數', `${d.筆數} 筆`], ['總金額', `NT$ ${d.總金額} 元`],
      ];
      fields.forEach(([k, v], i) => {
        const x = i % 2 === 0 ? L : W / 2 + 10;
        text(`${k}：`, x, y, 11, true); text(v || '—', x + 62, y, 11);
        if (i % 2 === 1) y += 22;
      });
      text('出差描述：', L, y, 11, true);
      g.font = `400 11px ${FONT}`;
      const desc = d.出差描述 || '—';
      let line = '', lx = L + 62;
      for (const ch of desc) {
        if (ch === '\n' || g.measureText(line + ch).width > R - lx) { text(line, lx, y); y += 18; line = ch === '\n' ? '' : ch; }
        else line += ch;
      }
      text(line, lx, y); y += 30;
    } else {
      text(`（續 第 ${pi + 1} 頁）`, W / 2, y - 14, 10, false, 'center');
    }
    // 表格
    const cols = [{ t: '序號', w: 50 }, { t: '車票日期', w: 120 }, { t: '起站', w: 90 }, { t: '迄站', w: 90 }, { t: '金額', w: R - L - 350 }];
    const rowH = 22;
    const drawRow = (vals: string[], header = false) => {
      let x = L;
      if (header) { g.fillStyle = '#e7eef7'; g.fillRect(L, y, R - L, rowH); g.fillStyle = '#111'; }
      g.strokeStyle = '#888'; g.lineWidth = 0.6;
      cols.forEach((col, i) => {
        g.strokeRect(x, y, col.w, rowH);
        const right = i === 4 && !header;
        text(vals[i], right ? x + col.w - 8 : x + col.w / 2, y + rowH / 2, 10.5, header, right ? 'right' : 'center');
        x += col.w;
      });
      y += rowH;
    };
    drawRow(cols.map((c) => c.t), true);
    for (const r of chunks[pi]) drawRow([String(r.序號), r.日期, r.起站, r.迄站, r.金額]);
    if (pi === chunks.length - 1) drawRow(['合計', `${d.筆數} 筆`, '', '', d.總金額], true);
    if (pi === chunks.length - 1) {
      y += 40;
      text('申請人簽章：______________________', L, y, 11);
      text('主管核准：______________________', W / 2 + 10, y, 11);
    }
    text(`第 ${pi + 1} / ${chunks.length} 頁`, W / 2, H - 30, 9, false, 'center');
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
    pages.push({ data: new Uint8Array(await blob.arrayBuffer()), type: 'png' as const, width: W, height: H });
  }
  return pages;
}
