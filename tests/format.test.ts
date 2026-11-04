import { describe, expect, it } from 'vitest';
import { buildCsv, formatMoney, isValidYmd, missingFields, sumFares, toYmd, todayString, ymdToSlash } from '../src/format';
import { newTicket } from '../src/types';

describe('日期格式', () => {
  it('今天 yyyy/mm/dd', () => {
    expect(todayString(new Date(2026, 10, 4))).toBe('2026/11/04');
    expect(todayString(new Date(2026, 0, 9))).toBe('2026/01/09');
  });
  it('各種寫法轉 YYYYMMDD', () => {
    expect(toYmd('2026/10/1')).toBe('20261001');
    expect(toYmd('2026-10-01 09:19:00')).toBe('20261001');
    expect(toYmd('2026年10月1日')).toBe('20261001');
    expect(toYmd('115/10/01')).toBe('20261001');
    expect(toYmd('20261001')).toBe('20261001');
    expect(toYmd('2026/02/30')).toBe('');
    expect(toYmd('')).toBe('');
  });
  it('合法性與顯示', () => {
    expect(isValidYmd('20240229')).toBe(true);
    expect(isValidYmd('20250229')).toBe(false);
    expect(ymdToSlash('20261001')).toBe('2026/10/01');
  });
});

describe('金額', () => {
  it('加總忽略空值', () => {
    expect(sumFares([{ fare: 130 }, { fare: null }, { fare: 1430 }])).toBe(1560);
    expect(sumFares([])).toBe(0);
  });
  it('千分位', () => {
    expect(formatMoney(1560)).toBe('1,560');
  });
  it('CSV 依日期排序並附總計', () => {
    const csv = buildCsv([
      newTicket({ date: '20261005', dep: '桃園', arr: '板橋', fare: 130 }),
      newTicket({ date: '20261001', dep: '板橋', arr: '桃園', fare: 130 }),
    ]);
    expect(csv).toBe('日期,起,迄,金額\n20261001,板橋,桃園,130\n20261005,桃園,板橋,130\n總計,,,260\n');
  });
});

describe('缺漏欄位', () => {
  it('對號座需要訂位代號；起迄站不可相同', () => {
    const t = newTicket({ source: 'mobile', seat: 'reserved', date: '20261001', dep: '板橋', arr: '板橋', ticketNo: '2900000000001', fare: 130 });
    expect(missingFields(t)).toEqual(['arr', 'bookingCode']);
    expect(missingFields({ ...t, seat: 'free', arr: '桃園' })).toEqual([]);
  });
});

describe('已有 PDF 的票', () => {
  it('不再要求類型、座別、號碼', () => {
    const t = newTicket({ date: '20261001', dep: '板橋', arr: '桃園', fare: 130 });
    expect(missingFields(t)).toContain('seat');
    t.pdf = { name: 'a.pdf', bytes: new Uint8Array(), password: '20261001' };
    expect(missingFields(t)).toEqual([]);
    expect(missingFields({ ...t, fare: null })).toEqual(['fare']);
    expect(missingFields({ ...t, fare: null, pdf: undefined })).not.toContain('fare');
  });
});
