// Local acceptance server: production builds at their GitHub Pages paths.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
const shapeCut = process.env.SHAPECUT_DIST;
if (!shapeCut) throw new Error('Set SHAPECUT_DIST to the ShapeCut production dist directory');
const roots = { '/ShapeCut/': resolve(shapeCut), '/steam-top/': resolve('apps/web/dist') };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json' };
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const entry = Object.entries(roots).find(([prefix]) => path.startsWith(prefix));
    if (!entry) { res.writeHead(404).end(); return; }
    const [prefix, root] = entry;
    const file = resolve(root, path.slice(prefix.length) || 'index.html');
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(bytes);
  } catch { res.writeHead(404).end(); }
}).listen(4178, '127.0.0.1');
