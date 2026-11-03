import { getRepo, handle } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(req, () => ({ snapshot: getRepo().snapshot() }));
}
