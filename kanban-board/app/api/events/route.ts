import { errorResponse, getFeed, getRepo, guardRequest } from '../../../lib/server';

export const dynamic = 'force-dynamic';

/** 변경 알림(SSE). 알림에는 번호만 담고, 내용은 /api/changes로 가져가게 한다. */
export async function GET(req: Request) {
  const blocked = await guardRequest(req);
  if (blocked) return blocked;
  let firstRevision: number;
  try {
    const repo = await getRepo(); // 저장소를 먼저 열어 둔다 (연결 설정이 틀리면 여기서 알려준다)
    firstRevision = (await repo.snapshot()).revision;
  } catch (e) {
    return errorResponse(e);
  }
  const enc = new TextEncoder();
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          /* 이미 닫힌 연결 */
        }
      };
      send(`retry: 2000\n\n`);
      send(`event: change\ndata: ${firstRevision}\n\n`);
      const close = () => {
        if (ping) clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* 이미 닫힌 연결 */
        }
      };
      unsubscribe = getFeed().subscribe((rev) => send(`event: change\ndata: ${rev}\n\n`), close);
      ping = setInterval(() => send(`event: ping\ndata: 0\n\n`), 15_000); // 화면이 연결이 살아 있는지 알 수 있게
      req.signal.addEventListener('abort', () => {
        unsubscribe();
        if (ping) clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* noop */
        }
      });
    },
    cancel() {
      unsubscribe();
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
