import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const publicRoot = 'apps/web/public/';
test('icon links retain the configured deployment base', () => {
  const html = readFileSync('apps/web/index.html', 'utf8');
  expect(html).toContain('href="%BASE_URL%icons/favicon.svg"');
  expect(html).toContain('href="%BASE_URL%icons/favicon.ico"');
  expect(html).toContain('href="%BASE_URL%icons/apple-touch-icon.png"');
  expect(html).toContain('href="%BASE_URL%site.webmanifest"');
});
test('all PNG sizes and legacy ICO are valid raster assets', () => {
  for (const [name, size] of [['favicon-32.png',32], ['apple-touch-icon.png',180], ['icon-192.png',192], ['icon-512.png',512]] as const) {
    const bytes = readFileSync(`${publicRoot}icons/${name}`);
    expect(bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([size,size]);
  }
  const ico = readFileSync(`${publicRoot}icons/favicon.ico`);
  expect(ico.subarray(0,6).toString('hex')).toBe('000001000100');
  expect(ico.subarray(22)).toEqual(readFileSync(`${publicRoot}icons/favicon-32.png`));
});
test('manifest stays in browser mode and uses same-directory resources', () => {
  const manifest = JSON.parse(readFileSync(`${publicRoot}site.webmanifest`, 'utf8'));
  expect(manifest.display).toBe('browser');
  expect(manifest.start_url).toBe('./');
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual(['icons/icon-192.png','icons/icon-512.png']);
  const svg = readFileSync(`${publicRoot}icons/favicon.svg`, 'utf8');
  expect(svg).toContain('viewBox="0 0 512 512"');
  expect(svg).not.toMatch(/<script|<image|<foreignObject|href=/i);
});
