import type { Changes, Snapshot } from '../lib/types';

export type Body = Record<string, unknown>;
/**
 * 서버에 변경을 보내는 함수.
 * - body: 보낼 내용. 함수로 주면 "보낼 차례가 됐을 때"의 최신 서버 상태로 내용을 만든다 (앞선 변경 결과를 반영).
 *         null을 돌려주면 보낼 것이 없다는 뜻이다 (예: 이미 그 상태).
 * - optimistic: 응답을 기다리지 않고 화면에 먼저 보여줄 변화. 성공·실패와 관계없이 응답이 오면 걷어 낸다.
 */
export type Act = (body: Body | ((s: Snapshot) => Body | null), optimistic?: (s: Snapshot) => Snapshot) => Promise<boolean>;

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
