import { describe, expect, it } from 'vitest';
import { pickOrigin, siteImageKey } from '../src/lib/sites';

describe('site detection', () => {
  it('picks the most viewed public origin', () => {
    expect(pickOrigin([
      { origin: 'https://www.example.com', n: 40 },
      { origin: 'http://localhost:5173', n: 900 },
      { origin: 'https://shop.example.com', n: 120 },
    ])).toBe('https://shop.example.com');
  });
  it.each([
    'http://localhost:3000', 'http://127.0.0.1:8080', 'http://192.168.1.4', 'https://10.0.0.2', 'http://myapp.local',
    'http://intranet', 'file:///x', 'chrome-extension://abc', 'https://u:p@example.com', '', 'nope',
  ])('leaves out %s', (origin) => expect(pickOrigin([{ origin, n: 1 }])).toBeNull());
  it('normalises case and default ports', () => {
    expect(pickOrigin([{ origin: 'HTTPS://Example.COM:443', n: 1 }])).toBe('https://example.com');
    expect(pickOrigin([{ origin: 'http://example.com:8080', n: 1 }])).toBe('http://example.com:8080');
  });
  it('stores one image per project and day', () => {
    expect(siteImageKey('p1', '2026-11-19')).toBe('sites/project_id=p1/2026-11-19.jpg');
  });
});

describe('screenshot address check', async () => {
  const { isPublicIp } = await import('../src/lib/screenshot');
  it.each(['104.20.23.154', '2606:4700:10::6814:179a', '::ffff:8.8.8.8'])('allows %s', (a) => expect(isPublicIp(a)).toBe(true));
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', 'example.com'])(
    'blocks %s', (a) => expect(isPublicIp(a)).toBe(false),
  );
});

describe('site icons', async () => {
  const { iconDataUrl } = await import('../src/lib/screenshot');
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  it('keeps image types up to 64 KB', () => {
    expect(iconDataUrl('image/png', png)).toBe('data:image/png;base64,iVBORw==');
    expect(iconDataUrl('Image/X-Icon; charset=binary', png)).toMatch(/^data:image\/x-icon;base64,/);
    expect(iconDataUrl('image/svg+xml', png)).toMatch(/^data:image\/svg\+xml;/);
  });
  it.each([['text/html', png], [undefined, png], ['image/png', new Uint8Array(0)], ['image/png', new Uint8Array(64 * 1024 + 1)]])(
    'drops %s', (type, bytes) => expect(iconDataUrl(type, bytes)).toBeNull(),
  );
});
