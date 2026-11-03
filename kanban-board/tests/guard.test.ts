import { describe, it, expect } from 'vitest';
import { afterEach } from 'vitest';
import path from 'node:path';
import { allowedPorts, checkRequest } from '../lib/guard';
import { uploadsDir } from '../lib/server';

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

  describe('KANBAN_ALLOWED_PORTS 값 읽기', () => {
    const saved = process.env.KANBAN_ALLOWED_PORTS;
    afterEach(() => {
      if (saved === undefined) delete process.env.KANBAN_ALLOWED_PORTS;
      else process.env.KANBAN_ALLOWED_PORTS = saved;
    });
    it('적지 않았거나, 비었거나, 숫자가 아니면 기본값 3000 (모든 요청이 막히지 않게)', () => {
      for (const v of [undefined, '', '   ', 'abc', ',', '0', '-1', '70000']) {
        if (v === undefined) delete process.env.KANBAN_ALLOWED_PORTS;
        else process.env.KANBAN_ALLOWED_PORTS = v;
        expect(allowedPorts(), `값=${JSON.stringify(v)}`).toEqual([3000]);
      }
    });
    it('쉼표로 여러 개, 앞뒤 공백 허용, 이상한 값은 빼고 읽는다', () => {
      process.env.KANBAN_ALLOWED_PORTS = ' 3000 , 8080,abc ';
      expect(allowedPorts()).toEqual([3000, 8080]);
      process.env.KANBAN_ALLOWED_PORTS = '8080';
      expect(allowedPorts()).toEqual([8080]);
    });
  });

  describe('KANBAN_UPLOADS 값 읽기', () => {
    const saved = process.env.KANBAN_UPLOADS;
    afterEach(() => {
      if (saved === undefined) delete process.env.KANBAN_UPLOADS;
      else process.env.KANBAN_UPLOADS = saved;
    });
    it('적지 않았거나 비어 있으면 앱 폴더 아래 data/uploads, 적었으면 그 폴더', () => {
      const def = path.join(process.cwd(), 'data', 'uploads');
      for (const v of [undefined, '', '   ']) {
        if (v === undefined) delete process.env.KANBAN_UPLOADS;
        else process.env.KANBAN_UPLOADS = v;
        expect(uploadsDir(), `값=${JSON.stringify(v)}`).toBe(def);
      }
      process.env.KANBAN_UPLOADS = ' /srv/kanban/uploads ';
      expect(uploadsDir()).toBe('/srv/kanban/uploads');
    });
  });

  it('막혔을 때 무엇을 하면 되는지 알려준다 (포트가 다를 때·주소가 다를 때)', () => {
    const port = checkRequest({ method: 'GET', headers: h({ host: '127.0.0.1:8080' }) }, ports);
    expect(port.ok).toBe(false);
    if (!port.ok) expect(port.reason).toContain('KANBAN_ALLOWED_PORTS=3000,8080');
    const ip = checkRequest({ method: 'GET', headers: h({ host: '192.168.0.10:3000' }) }, ports);
    expect(ip.ok).toBe(false);
    if (!ip.ok) expect(ip.reason).toContain('SSH 터널');
  });
});
