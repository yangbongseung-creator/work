export type HeaderLike = { get(name: string): string | null };
export type GuardResult = { ok: true } | { ok: false; status: number; reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function allowedPorts(): number[] {
  const raw = process.env.KANBAN_ALLOWED_PORTS ?? '3000';
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function splitHost(hostPort: string): { hostname: string; port: number | null } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostPort.trim());
  if (!m) return null;
  return { hostname: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : null };
}

function localOk(hostPort: string, ports: number[]): boolean {
  const p = splitHost(hostPort);
  if (!p || !LOCAL_HOSTS.has(p.hostname)) return false;
  return p.port !== null && ports.includes(p.port);
}

/**
 * 로그인이 없는 로컬 서버를 다른 웹사이트가 두드리지 못하게 막는다.
 * - 모든 요청: Host가 localhost/127.0.0.1(허용 포트)이어야 한다 (DNS 위장 방지)
 * - 데이터를 바꾸는 요청: Origin이 있어야 하고 로컬이어야 하며, application/json만 받는다
 */
export function checkRequest(
  req: { method: string; headers: HeaderLike },
  ports: number[] = allowedPorts(),
): GuardResult {
  const host = req.headers.get('host');
  if (!host || !localOk(host, ports)) {
    return { ok: false, status: 403, reason: '허용되지 않은 주소(Host)입니다.' };
  }
  const origin = req.headers.get('origin');
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
  if (origin) {
    let o: URL | null = null;
    try {
      o = new URL(origin);
    } catch {
      o = null;
    }
    if (!o || !localOk(o.host, ports)) {
      return { ok: false, status: 403, reason: '허용되지 않은 출처(Origin)입니다.' };
    }
  } else if (mutating) {
    return { ok: false, status: 403, reason: '출처(Origin)가 없는 변경 요청은 받을 수 없습니다.' };
  }
  if (mutating) {
    const ct = (req.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return { ok: false, status: 415, reason: 'JSON 요청만 받을 수 있습니다.' };
    }
  }
  return { ok: true };
}
