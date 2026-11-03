/**
 * 인증(로그인)이 들어갈 자리.
 * 지금은 로그인이 없어서 항상 통과시킨다 (SSH 터널로만 접속하므로). 로그인을 붙일 때 여기만 바꾸면 된다.
 */
export async function authenticate(_req: Request): Promise<boolean> {
  return true;
}
