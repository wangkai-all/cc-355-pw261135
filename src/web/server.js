import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS, HOST } from '../shared/config.js';
import { fail } from '../shared/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// 精确的路径前缀 → 微服务映射
const PROXY_RULES = [
  { prefix: '/api/admin/clients', port: PORTS.TASK },
  { prefix: '/api/admin/tasks', port: PORTS.TASK },
  { prefix: '/api/admin/audit', port: PORTS.TASK }, // 同名接口两边都有，默认走 ingest，见特殊处理
  { prefix: '/api/devices', port: PORTS.TASK },
  { prefix: '/api/my/tasks', port: PORTS.TASK },
  { prefix: '/api/my/batch', port: PORTS.INGEST },
  { prefix: '/api/my/records', port: PORTS.INGEST },
  { prefix: '/api/uploads', port: PORTS.INGEST },
  { prefix: '/api/admin/conflicts', port: PORTS.INGEST },
  { prefix: '/api/admin/records', port: PORTS.INGEST },
  { prefix: '/api/admin/stats', port: PORTS.INGEST },
  { prefix: '/api/admin/inbox', port: PORTS.INGEST },
];
// 审计日志两边各一份，用 ?source=task 区分
const SPECIAL = [
  { match: '/api/admin/audit', port: (search) => (new URLSearchParams(search).get('source') === 'task' ? PORTS.TASK : PORTS.INGEST) },
];

function pickUpstream(pathname, search) {
  for (const s of SPECIAL) if (pathname.startsWith(s.match)) return s.port(search);
  for (const r of PROXY_RULES) if (pathname.startsWith(r.prefix)) return r.port;
  return null;
}

function proxy(req, res, pathname, search) {
  const port = pickUpstream(pathname, search);
  if (!port) return fail(res, 404, 'NO_UPSTREAM', `网关没有该路径的上游: ${pathname}`);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    if (body.length) headers['content-length'] = body.length;
    const up = http.request(
      { hostname: HOST, port, path: pathname + search, method: req.method, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      }
    );
    up.on('error', () => fail(res, 502, 'UPSTREAM_DOWN', `上游服务 (${port}) 不可用`));
    if (body.length) up.write(body);
    up.end();
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/client.html' : pathname;
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'FORBIDDEN', '非法路径');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, 'client.html'); // 单页应用回退
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, `http://${HOST}`);
    if (u.pathname.startsWith('/internal/')) return fail(res, 404, 'NOT_FOUND', '内部接口不对外暴露');
    if (u.pathname.startsWith('/api/')) return proxy(req, res, u.pathname, u.search);
    serveStatic(req, res, u.pathname);
  })
  .listen(PORTS.WEB, HOST, () => {
    console.log(`[web] 网关与前端监听 http://${HOST}:${PORTS.WEB}`);
    console.log(`       采样端A: http://${HOST}:${PORTS.WEB}/client.html?c=dev-a`);
    console.log(`       采样端B: http://${HOST}:${PORTS.WEB}/client.html?c=dev-b`);
    console.log(`       管理台: http://${HOST}:${PORTS.WEB}/admin.html`);
  });
