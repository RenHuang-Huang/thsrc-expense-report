/** 高鐵站名與 ptis 下拉選單代碼（南港 1 … 左營 12）。 */
export const STATIONS = [
  '南港', '台北', '板橋', '桃園', '新竹', '苗栗',
  '台中', '彰化', '雲林', '嘉義', '台南', '左營',
] as const;

export type Station = (typeof STATIONS)[number];

const EN: Record<string, Station> = {
  nangang: '南港', taipei: '台北', banqiao: '板橋', taoyuan: '桃園',
  hsinchu: '新竹', miaoli: '苗栗', taichung: '台中', changhua: '彰化',
  yunlin: '雲林', chiayi: '嘉義', tainan: '台南', zuoying: '左營',
};

/** 站名正規化：臺→台、去掉「高鐵」「車站」「站」、英文站名轉中文。不認得回傳空字串。 */
export function normalizeStation(raw: string | null | undefined): Station | '' {
  if (!raw) return '';
  let s = String(raw).trim().replace(/臺/g, '台').replace(/\s+/g, '');
  s = s.replace(/^高鐵/, '').replace(/車站$/, '').replace(/站$/, '');
  if ((STATIONS as readonly string[]).includes(s)) return s as Station;
  const en = EN[s.toLowerCase()];
  return en ?? '';
}

export function stationCode(name: string): number | null {
  const s = normalizeStation(name);
  return s ? STATIONS.indexOf(s) + 1 : null;
}

/** 依出現順序找出文字中的站名（中英文皆可），連續重複（如「板橋 Banqiao」）只算一次。 */
export function findStationsInOrder(text: string): Station[] {
  const t = text.replace(/臺/g, '台');
  const re = new RegExp(`(${STATIONS.join('|')}|${Object.keys(EN).join('|')})`, 'gi');
  const out: Station[] = [];
  for (const m of t.matchAll(re)) {
    const s = normalizeStation(m[1]);
    if (s && out[out.length - 1] !== s) out.push(s);
  }
  return out;
}
