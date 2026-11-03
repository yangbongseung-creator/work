import type { Changes, Snapshot } from '../lib/types';

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

export async function fetchChanges(since: number): Promise<Changes> {
  return parse(await fetch(`/api/changes?since=${since}`, { cache: 'no-store' }));
}

async function postJson(url: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parse(res);
}

export const mutate = (body: Record<string, unknown>) => postJson('/api/mutate', body);

export async function uploadFile(cardId: string, file: File): Promise<any> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return postJson('/api/upload', { cardId, name: file.name, data: btoa(bin) });
}
