import { getRepo, handle } from '../../../lib/server';
import { AppError } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req, async () => {
    let body: any;
    try {
      body = await req.json();
    } catch {
      throw new AppError('INVALID', '요청 형식이 올바르지 않아요.');
    }
    const repo = getRepo();
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    switch (body?.op) {
      case 'createBoard':
        return repo.createBoard(s(body.name));
      case 'renameBoard':
        return repo.renameBoard(s(body.id), s(body.name));
      case 'deleteBoard':
        return repo.deleteBoard(s(body.id));
      case 'addColumn':
        return repo.addColumn(s(body.boardId), s(body.name));
      case 'renameColumn':
        return repo.renameColumn(s(body.id), s(body.name));
      case 'deleteColumn':
        return repo.deleteColumn(s(body.id));
      case 'moveColumn':
        return repo.moveColumn(s(body.id), body.dir === -1 ? -1 : 1);
      case 'setColumnDone':
        return repo.setColumnDone(s(body.id), !!body.done);
      case 'addCard':
        return repo.addCard(s(body.columnId), s(body.title));
      case 'updateCard':
        return repo.updateCard(s(body.id), body.fields ?? {});
      case 'moveCard':
        return repo.moveCard(s(body.id), s(body.toColumnId), Number(body.index));
      case 'deleteCard':
        return repo.deleteCard(s(body.id));
      case 'patch':
        if (!body.patch || !Array.isArray(body.expect)) throw new AppError('INVALID', '요청 형식이 올바르지 않아요.');
        return repo.applyPatch(body.patch, body.expect);
      default:
        throw new AppError('INVALID', '알 수 없는 작업이에요.');
    }
  });
}
