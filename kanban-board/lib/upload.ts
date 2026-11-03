import { AppError, LIMITS } from './types';

export const ALLOWED_EXT: Record<string, string[]> = {
  이미지: ['png', 'jpg', 'jpeg', 'gif', 'webp'], // SVG는 스크립트를 담을 수 있어 제외
  문서: ['pdf', 'txt', 'md', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx'],
  압축: ['zip', '7z'],
};
const ALL = new Set(Object.values(ALLOWED_EXT).flat());
const IMAGE = new Set(ALLOWED_EXT['이미지']);

const INLINE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function startsWith(b: Uint8Array, sig: number[], at = 0) {
  return sig.every((v, i) => b[at + i] === v);
}
function looksLike(ext: string, b: Uint8Array): boolean {
  if (ext === 'png') return startsWith(b, [0x89, 0x50, 0x4e, 0x47]);
  if (ext === 'jpg' || ext === 'jpeg') return startsWith(b, [0xff, 0xd8, 0xff]);
  if (ext === 'gif') return startsWith(b, [0x47, 0x49, 0x46, 0x38]);
  if (ext === 'webp') return startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
  if (ext === 'pdf') return startsWith(b, [0x25, 0x50, 0x44, 0x46]);
  return true;
}

/** 확장자 허용 목록, 크기, 이미지·PDF는 파일 내용까지 확인한다. */
export function validateUpload(name: string, bytes: Uint8Array): { ext: string; mime: string } {
  const ext = extOf(name);
  if (!ext || !ALL.has(ext)) throw new AppError('INVALID_FILE', '허용되지 않는 파일 종류예요.');
  if (bytes.length === 0) throw new AppError('INVALID_FILE', '빈 파일은 올릴 수 없어요.');
  if (bytes.length > LIMITS.fileBytes) throw new AppError('INVALID_FILE', '파일은 10MB까지 올릴 수 있어요.');
  if ((IMAGE.has(ext) || ext === 'pdf') && !looksLike(ext, bytes)) {
    throw new AppError('INVALID_FILE', '파일 내용이 확장자와 달라서 올릴 수 없어요.');
  }
  return { ext, mime: INLINE_MIME[ext] ?? 'application/octet-stream' };
}

/** 화면에서 바로 보여줘도 안전한 종류(이미지·PDF)면 MIME, 아니면 null */
export function inlineMime(ext: string): string | null {
  return INLINE_MIME[ext] ?? null;
}

/** 다운로드 헤더에 넣을 파일명: 경로 구분자·특수문자·제어문자를 지운다 */
export function safeDownloadName(name: string): string {
  const cleaned = [...name]
    .filter((ch) => ch.charCodeAt(0) >= 32 && !'/\\:*?"<>|;,%'.includes(ch))
    .join('')
    .replace(/^\.+/, '')
    .trim();
  const cut = [...cleaned].slice(0, 120).join('');
  return cut || 'download';
}

export function contentDisposition(name: string, inline: boolean): string {
  const safe = safeDownloadName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * 저장할 파일명(200자 제한). 길면 확장자는 남기고 앞부분을 자른다.
 * 검사도 이 이름으로 해야, 잘리기 전/후 확장자가 달라지는 우회가 생기지 않는다.
 */
export function normalizeUploadName(name: string, max = 200): string {
  const n = name.trim();
  const cps = [...n];
  if (cps.length <= max) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot >= 0 && n.length - dot <= 11 ? n.slice(dot) : '';
  return [...n.slice(0, dot >= 0 && ext ? dot : n.length)].slice(0, max - [...ext].length).join('') + ext;
}
