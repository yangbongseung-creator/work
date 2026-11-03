import { errorResponse, getRepo, getStorage, guardRequest } from '../../../../lib/server';
import { contentDisposition, extOf, inlineMime } from '../../../../lib/upload';

export const dynamic = 'force-dynamic';

/** 첨부 내려받기: 이미지·PDF 외에는 항상 다운로드로 내려주고 nosniff를 붙인다 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const blocked = await guardRequest(req);
  if (blocked) return blocked;
  try {
    const { id } = await ctx.params;
    const att = await (await getRepo()).getAttachment(id);
    if (!att) return Response.json({ error: '파일을 찾을 수 없어요.' }, { status: 404 });
    const storage = getStorage();
    if (!storage.exists(att.storageKey)) return Response.json({ error: '파일이 정리되어 없어요.' }, { status: 410 });
    const data = await storage.read(att.storageKey);
    const safeMime = inlineMime(extOf(att.name));
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': safeMime ?? 'application/octet-stream',
        'Content-Disposition': contentDisposition(att.name, !!safeMime),
        'Content-Length': String(data.length),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=0, must-revalidate',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
