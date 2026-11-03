/**
 * 인증이 들어갈 자리.
 * 지금은 로그인이 없어서 항상 통과시킨다. Vercel 배포 전에 방식을 정하고 여기만 바꾼다.
 */
export async function authenticate(_req: Request): Promise<boolean> {
  return true;
}
