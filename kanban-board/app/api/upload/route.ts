import { randomUUID } from 'node:crypto';
import { getRepo, getStorage, handle } from '../../../lib/server';
import { normalizeUploadName, validateUpload } from '../../../lib/upload';
import { AppError, LIMITS } from '../../../lib/types';

export const dynamic = 'force-dynamic';

/** 첨부 올리기. 변경 API는 JSON만 받으므로 파일 내용은 base64로 보낸다. */
export async function POST(req: Request) {
  return handle(req, async () => {
    let body: any;
    try {
      body = await req.json();
    } catch {
      throw new AppError('INVALID', '요청 형식이 올바르지 않아요.');
    }
    const cardId = typeof body?.cardId === 'string' ? body.cardId : '';
    const name = typeof body?.name === 'string' ? normalizeUploadName(body.name) : ''; // 저장될 이름 기준으로 검사한다
    const data = typeof body?.data === 'string' ? body.data : '';
    if (!cardId || !name || !data) throw new AppError('INVALID', '파일 정보가 부족해요.');
    // 서버에서도 개수·크기를 검사한다 (화면 검사에만 기대지 않는다)
    if (data.length > Math.ceil((LIMITS.fileBytes * 4) / 3) + 8) throw new AppError('INVALID_FILE', '파일은 10MB까지 올릴 수 있어요.');
    const bytes = Buffer.from(data, 'base64');
    const repo = await getRepo();
    if ((await repo.attachmentCount(cardId)) >= LIMITS.attachmentsPerCard) {
      throw new AppError('LIMIT', `첨부파일은 카드당 ${LIMITS.attachmentsPerCard}개까지 올릴 수 있어요.`);
    }
    const { mime } = validateUpload(name, bytes);
    const storage = getStorage();
    const storageKey = randomUUID(); // 저장 이름은 새 ID, 원래 파일명은 DB에만 둔다
    await storage.put(storageKey, bytes);
    try {
      return await repo.addAttachment(cardId, { name, size: bytes.length, mime, storageKey });
    } catch (e) {
      await storage.remove(storageKey); // 실패하면 남은 파일을 지운다
      throw e;
    }
  });
}
