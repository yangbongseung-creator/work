import { isYmd } from './dates';
import { AppError, LABEL_COLORS, LIMITS, type Expect, type Kind, type Patch } from './types';

const KINDS: Kind[] = ['board', 'column', 'card', 'check', 'comment', 'attachment'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 20000;
/** 저장 키에는 경로를 만들 수 있는 문자(/, \\, ..)가 들어갈 수 없다 */
const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const bad = (): never => {
  throw new AppError('INVALID', '요청 형식이 올바르지 않아요.');
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, min = 0) => typeof v === 'string' && [...v].length <= max && [...v].length >= min;
const int = (v: unknown, min = 0) => typeof v === 'number' && Number.isInteger(v) && v >= min;
const uuid = (v: unknown) => typeof v === 'string' && UUID.test(v);

/** 클라이언트가 보낸 되돌리기 묶음이 서버가 만든 모양과 한도에 맞는지 검사한다 (검사 없이 그대로 저장하지 않기 위해) */
export function assertValidPatch(patch: unknown, expect: unknown): asserts patch is Patch {
  if (!isObj(patch) || !Array.isArray(patch.upsert) || !Array.isArray(patch.remove) || !Array.isArray(expect)) bad();
  const p = patch as { upsert: unknown[]; remove: unknown[] };
  if (p.upsert.length + p.remove.length > MAX_ITEMS || (expect as unknown[]).length > MAX_ITEMS) bad();
  for (const raw of expect as unknown[]) {
    if (!isObj(raw)) return bad();
    const e = raw as { key?: unknown; rev?: unknown };
    if (typeof e.key !== 'string' || !(e.rev === null || int(e.rev))) return bad();
    const i = e.key.indexOf(':');
    if (i < 0 || !KINDS.includes(e.key.slice(0, i) as Kind) || !uuid(e.key.slice(i + 1))) return bad();
  }
  for (const r of p.remove) {
    if (!isObj(r) || !KINDS.includes(r.kind as Kind) || !uuid(r.id)) bad();
  }
  for (const u of p.upsert) {
    if (!isObj(u) || !KINDS.includes(u.kind as Kind) || !isObj(u.row)) bad();
    const row = (u as { kind: Kind; row: Record<string, unknown> }).row;
    const kind = (u as { kind: Kind }).kind;
    if (!uuid(row.id) || !int(row.rev)) bad();
    if (kind === 'board') {
      if (!str(row.name, LIMITS.boardName, 1) || !int(row.position, -1_000_000)) bad();
    } else if (kind === 'column') {
      if (!uuid(row.boardId) || !str(row.name, LIMITS.columnName, 1) || !int(row.position, -1_000_000) || typeof row.isDone !== 'boolean') bad();
    } else if (kind === 'card') {
      const labels = row.labels;
      if (
        !uuid(row.columnId) ||
        !str(row.title, LIMITS.cardTitle, 1) ||
        !str(row.description, LIMITS.cardDescription) ||
        !str(row.assignee, 50) ||
        !(row.dueDate === null || isYmd(row.dueDate)) ||
        !['none', 'daily', 'weekly', 'monthly'].includes(row.repeat as string) ||
        (row.repeat !== 'none' && row.dueDate === null) ||
        !Array.isArray(labels) ||
        labels.some((l) => !(LABEL_COLORS as readonly string[]).includes(l)) ||
        new Set(labels).size !== labels.length ||
        typeof row.archived !== 'boolean' ||
        !int(row.position, -1_000_000) ||
        !(row.followupId === null || uuid(row.followupId))
      ) bad();
    } else if (kind === 'check') {
      if (!uuid(row.cardId) || !str(row.text, LIMITS.checkText, 1) || typeof row.done !== 'boolean' || !int(row.position, -1_000_000)) bad();
    } else if (kind === 'comment') {
      if (!uuid(row.cardId) || !str(row.body, LIMITS.commentBody, 1) || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string' || Number.isNaN(Date.parse(row.createdAt as string)) || Number.isNaN(Date.parse(row.updatedAt as string))) bad();
    } else {
      if (!uuid(row.cardId) || !str(row.name, 200, 1) || !int(row.size) || !str(row.mime, 200) || !(typeof row.storageKey === 'string' && SAFE_KEY.test(row.storageKey))) bad();
    }
  }
}
