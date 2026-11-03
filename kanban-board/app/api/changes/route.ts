import { getRepo, handle } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(req, () => {
    const since = Number(new URL(req.url).searchParams.get('since'));
    return getRepo().changesSince(Number.isFinite(since) ? since : -1);
  });
}
