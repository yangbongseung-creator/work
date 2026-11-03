export type HeaderLike = { get(name: string): string | null };
export type GuardResult = { ok: true } | { ok: false; status: number; reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function allowedPorts(): number[] {
  const ports = (process.env.KANBAN_ALLOWED_PORTS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  // 적지 않았거나 비어 있거나 숫자가 아니면 기본값 3000 (모든 요청이 막히는 일을 막는다)
  return ports.length > 0 ? ports : [3000];
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

/** 접속 주소가 막혔을 때 "무엇을 하면 되는지" 알려주는 안내 (사용자가 직접 고칠 수 있게) */
function hostHint(host: string | null, ports: number[]): string {
  const p = host ? splitHost(host) : null;
  if (p && LOCAL_HOSTS.has(p.hostname) && p.port !== null && !ports.includes(p.port)) {
    return `허용되지 않은 주소(Host)입니다. 포트 ${p.port}번으로 접속했어요. http://127.0.0.1:${ports[0] ?? 3000} 으로 접속하거나, SSH 터널의 내 PC 쪽 포트를 바꿨다면 서버의 .env에 KANBAN_ALLOWED_PORTS=${[...ports, p.port].join(',')} 를 넣고 앱을 다시 켜 주세요.`;
  }
  return '허용되지 않은 주소(Host)입니다. 이 앱은 http://127.0.0.1:3000 (또는 localhost) 주소로만 열 수 있어요. 서버 IP 대신 SSH 터널을 열고 이 주소로 접속해 주세요.';
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
    return { ok: false, status: 403, reason: hostHint(host, ports) };
  }
  // 브라우저가 알려주는 "요청을 보낸 곳" — 다른 사이트(cross-site)나 같은 PC의 다른 주소(same-site)에서 온 요청은 막는다.
  // 'same-origin'(우리 화면)과 'none'(주소창에 직접 입력)은 통과. 헤더가 없으면(curl 등) 다른 검사에 맡긴다.
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, reason: '다른 사이트에서 온 요청은 받을 수 없습니다.' };
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
