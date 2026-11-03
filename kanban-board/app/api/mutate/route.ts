import { getRepo, handle } from '../../../lib/server';
import { AppError, type NotifyKind } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req, async () => {
    let body: any;
    try {
      body = await req.json();
    } catch {
      throw new AppError('INVALID', '요청 형식이 올바르지 않아요.');
    }
    const repo = await getRepo();
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const today = typeof body?.today === 'string' ? body.today : undefined;
    switch (body?.op) {
      case 'createBoard':
        return repo.createBoard(s(body.name));
      case 'renameBoard':
        return repo.renameBoard(s(body.id), s(body.name));
      case 'deleteBoard':
        return repo.deleteBoard(s(body.id));
      case 'duplicateBoard':
        return repo.duplicateBoard(s(body.id));
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
        return repo.moveCard(s(body.id), s(body.toColumnId), Number(body.index), today);
      case 'deleteCard':
        return repo.deleteCard(s(body.id));
      case 'duplicateCard':
        return repo.duplicateCard(s(body.id));
      case 'setArchived':
        return repo.setArchived(ids(body.ids), !!body.archived);
      case 'bulkMove':
        return repo.bulkMove(ids(body.ids), s(body.toColumnId), today);
      case 'bulkDelete':
        return repo.bulkDelete(ids(body.ids));
      case 'addCheck':
        return repo.addCheck(s(body.cardId), s(body.text));
      case 'updateCheck':
        return repo.updateCheck(s(body.id), body.fields ?? {});
      case 'deleteCheck':
        return repo.deleteCheck(s(body.id));
      case 'addComment':
        return repo.addComment(s(body.cardId), s(body.body));
      case 'updateComment':
        return repo.updateComment(s(body.id), s(body.body));
      case 'deleteComment':
        return repo.deleteComment(s(body.id));
      case 'deleteAttachment':
        return repo.deleteAttachment(s(body.id));
      case 'dismiss':
        return repo.dismiss(s(body.cardId), s(body.kind) as NotifyKind, s(body.dueDate));
      case 'patch':
        if (!body.patch || !Array.isArray(body.patch.upsert) || !Array.isArray(body.patch.remove) || !Array.isArray(body.expect)) {
          throw new AppError('INVALID', '요청 형식이 올바르지 않아요.');
        }
        return repo.applyPatch(body.patch, body.expect);
      default:
        throw new AppError('INVALID', '알 수 없는 작업이에요.');
    }
  });
}
