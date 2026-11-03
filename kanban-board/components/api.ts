import type { Snapshot } from '../lib/types';

async function parse(res: Response) {
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (!res.ok) throw new Error(data?.error ?? `요청에 실패했어요 (${res.status})`);
  return data;
}

export async function fetchState(): Promise<Snapshot> {
  return (await parse(await fetch('/api/state', { cache: 'no-store' }))).snapshot;
}

export async function mutate(body: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parse(res);
}
