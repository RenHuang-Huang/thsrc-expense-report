import { describe, expect, it } from 'vitest';
import { parseProofText, parseTicketText, scoreParsed } from '../src/parse';
import { findStationsInOrder, normalizeStation, stationCode } from '../src/stations';

describe('站名', () => {
  it('正規化臺/台、英文、高鐵…車站', () => {
    expect(normalizeStation('臺北')).toBe('台北');
    expect(normalizeStation('高鐵板橋車站')).toBe('板橋');
    expect(normalizeStation('Zuoying')).toBe('左營');
    expect(normalizeStation('火星')).toBe('');
  });
  it('代碼 南港1…左營12', () => {
    expect(stationCode('南港')).toBe(1);
    expect(stationCode('臺南')).toBe(11);
    expect(stationCode('左營')).toBe(12);
  });
  it('中英文連續出現只算一次', () => {
    expect(findStationsInOrder('桃園 Taoyuan 20:38 --- 板橋 Banqiao 20:50')).toEqual(['桃園', '板橋']);
  });
});

describe('T Express 截圖 OCR 文字', () => {
  const text = `09:41
T Express
2026/10/21 (三)
板 橋 Banqiao  →  桃 園 Taoyuan
車次 0603   標準車廂 對號座
訂位代號 0123 4567
車票號碼 2900000000001
全票`;
  it('解析各欄位', () => {
    const p = parseTicketText(text);
    expect(p).toMatchObject({
      source: 'mobile', seat: 'reserved', date: '20261021',
      dep: '板橋', arr: '桃園', ticketNo: '2900000000001', bookingCode: '01234567',
    });
    expect(p.fare).toBeUndefined();
    expect(scoreParsed(p)).toBeGreaterThanOrEqual(7);
  });

  it('自由座（只有購票序號）沒有訂位代號', () => {
    const p = parseTicketText(`T Express\n2026/10/05\n台北 → 新竹\n自由座\n購票序號 123456\n車票號碼 2911111111111`);
    expect(p.seat).toBe('free');
    expect(p.bookingCode).toBe('');
    expect(p.dep).toBe('台北');
    expect(p.arr).toBe('新竹');
  });
});

describe('紙本車票 OCR 文字', () => {
  it('票號去連字號、NT$ 金額、8 碼訂位代號', () => {
    const p = parseTicketText(`台灣高鐵 THSR
2026/10/01 678
桃園 Taoyuan → 板橋 Banqiao
20:38  20:50
NT$130 標準車廂 對號座
07654321
04-1-02-0-000-0123
變更乙次`);
    expect(p).toMatchObject({
      source: 'paper', seat: 'reserved', date: '20261001', dep: '桃園', arr: '板橋',
      ticketNo: '0410200000123', bookingCode: '07654321', fare: 130,
    });
  });

  it('民國年日期', () => {
    expect(parseTicketText('115/10/01 板橋 桃園').date).toBe('20261001');
  });

  it('全形數字', () => {
    expect(parseTicketText('２０２６／１０／２２ 板橋 桃園').date).toBe('20261022');
  });
});

describe('電子車票證明 PDF 內文', () => {
  it('手機電子票證版型', () => {
    const p = parseProofText(
      '統一編號 : 12345678 台灣高鐵電子車票證明 列印日期：2026-11-04 營利事業名稱 : 範例股份有限公司 ' +
      '卡號/票號 : 2900000000001 付款日期 : 乘車日期 : 2026-10-01 09:19:00 票證類別 : 手機電子票證 ' +
      '起程站 : 高鐵板橋車站 到達站 : 高鐵桃園車站 銷售額 : 124 營業稅額 : 6 票價 : 130 控管編號 : 290000000000126100');
    expect(p).toMatchObject({ ticketNo: '2900000000001', date: '20261001', dep: '板橋', arr: '桃園', fare: 130, source: 'mobile' });
  });

  it('紙本交易紀錄版型', () => {
    const p = parseProofText(
      '台灣高鐵交易紀錄 Transaction Record 票種 Ticket Type : 訂位代號 Reservation No. : 開立日期 Issue Date : ' +
      '車次 Train No. 區間 Itinerary 票款 Fare 2026/10/01 桃園 Taoyuan 20:38 --- 板橋 Banqiao 20:50 NT$130 ' +
      '2026/11/04 07654321 乘車日期 Travel Date 678 0410200000123 普通票 Regular Ticket 票號 Ticket No.');
    expect(p).toMatchObject({
      ticketNo: '0410200000123', date: '20261001', dep: '桃園', arr: '板橋',
      fare: 130, source: 'paper', bookingCode: '07654321',
    });
  });
});
