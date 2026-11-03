/** 날짜는 모두 'YYYY-MM-DD' 문자열. 시간대 영향을 받지 않게 UTC로만 계산한다. */
export function isYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d); // Date.UTC는 0~99년을 1900년대로 바꿔 버려서 쓰지 않는다
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const p2 = (n: number) => String(n).padStart(2, '0');
const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${p2(m)}-${p2(d)}`;

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function tomorrowOf(today: string): string {
  return addDays(today, 1);
}

/** 완료한 날짜(today)를 기준으로 다음 마감일을 계산한다. 다음 달에 같은 날이 없으면 그 달 마지막 날. */
export function nextDueDate(today: string, repeat: 'daily' | 'weekly' | 'monthly'): string {
  if (repeat === 'daily') return addDays(today, 1);
  if (repeat === 'weekly') return addDays(today, 7);
  const [y, m, d] = today.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate(); // nm월의 마지막 날
  return fmt(ny, nm, Math.min(d, last));
}
