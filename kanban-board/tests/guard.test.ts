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

  it('브라우저가 "다른 사이트에서 보냈다"고 알리면 읽기 요청도 거부한다 (Sec-Fetch-Site)', () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = checkRequest({ method: 'GET', headers: h({ host: '127.0.0.1:3000', 'sec-fetch-site': site }) }, ports);
      expect(r.ok, site).toBe(false);
    }
    for (const site of ['same-origin', 'none']) {
      const r = checkRequest({ method: 'GET', headers: h({ host: '127.0.0.1:3000', 'sec-fetch-site': site }) }, ports);
      expect(r.ok, site).toBe(true);
    }
  });

  it('IPv6 localhost와 대소문자 섞인 Host, 이상한 Host 값', () => {
    expect(checkRequest({ method: 'GET', headers: h({ host: '[::1]:3000' }) }, ports).ok).toBe(true);
    expect(checkRequest({ method: 'GET', headers: h({ host: 'LOCALHOST:3000' }) }, ports).ok).toBe(true);
    for (const bad of ['localhost', '127.0.0.1.evil.com:3000', 'evil.com:3000@127.0.0.1:3000', '', 'localhost:3000:3000', '127.0.0.1:03000x', 'localhost.:3000']) {
      expect(checkRequest({ method: 'GET', headers: h({ host: bad }) }, ports).ok, `Host=${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('Origin이 이상한 값(null, 파일, 다른 포트, 사용자정보 포함)이면 변경 요청을 거부한다', () => {
    for (const origin of ['null', 'file://', 'http://127.0.0.1:3001', 'http://localhost:3000@evil.com', 'http://evil.com', 'chrome-extension://abc']) {
      const r = checkRequest({ method: 'POST', headers: h({ host: '127.0.0.1:3000', origin, 'content-type': 'application/json' }) }, ports);
      expect(r.ok, `Origin=${origin}`).toBe(false);
    }
  });

  it('PUT·PATCH·DELETE 같은 다른 변경 메서드도 같은 검사를 받는다', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(checkRequest({ method, headers: h({ host: '127.0.0.1:3000', 'content-type': 'application/json' }) }, ports).ok, method).toBe(false);
    }
  });
});
