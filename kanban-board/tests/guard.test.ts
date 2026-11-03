import { describe, it, expect } from 'vitest';
import { checkRequest } from '../lib/guard';

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
const ports = [3000];

describe('로컬 서버 보호', () => {
  it('localhost·127.0.0.1에서 온 JSON 변경 요청은 통과한다', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000']) {
      const r = checkRequest(
        { method: 'POST', headers: h({ host, origin: `http://${host}`, 'content-type': 'application/json' }) },
        ports,
      );
      expect(r.ok).toBe(true);
    }
  });

  it('다른 웹사이트(Origin)에서 온 변경 요청은 거부한다', () => {
    const r = checkRequest(
      { method: 'POST', headers: h({ host: '127.0.0.1:3000', origin: 'https://evil.example', 'content-type': 'application/json' }) },
      ports,
    );
    expect(r.ok).toBe(false);
  });

  it('Origin이 없는 변경 요청은 거부한다', () => {
    const r = checkRequest({ method: 'POST', headers: h({ host: '127.0.0.1:3000', 'content-type': 'application/json' }) }, ports);
    expect(r.ok).toBe(false);
  });

  it('Host가 localhost가 아니면(DNS 위장) 읽기 요청도 거부한다', () => {
    const r = checkRequest({ method: 'GET', headers: h({ host: 'evil.example:3000' }) }, ports);
    expect(r.ok).toBe(false);
  });

  it('허용하지 않은 포트는 거부한다', () => {
    const r = checkRequest({ method: 'GET', headers: h({ host: '127.0.0.1:9999' }) }, ports);
    expect(r.ok).toBe(false);
  });

  it('JSON이 아닌 변경 요청은 거부한다', () => {
    const r = checkRequest(
      { method: 'POST', headers: h({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'text/plain' }) },
      ports,
    );
    expect(r.ok).toBe(false);
  });

  it('같은 사이트에서 온 읽기 요청은 Origin 없이도 통과한다', () => {
    const r = checkRequest({ method: 'GET', headers: h({ host: '127.0.0.1:3000' }) }, ports);
    expect(r.ok).toBe(true);
  });
});
