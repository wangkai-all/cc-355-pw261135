import http from 'node:http';
import { randomUUID } from 'node:crypto';

// ---------- 极简 JSON HTTP 框架（零依赖） ----------

/** 读取并解析 JSON 请求体 */
export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('非法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

export function fail(res, status, code, message, extra = {}) {
  sendJson(res, status, { ok: false, error: { code, message, ...extra } });
}

/**
 * 极简路由：routes = [{ method, pattern: '/x/:id', handler }]
 * handler 收到 (req, res, params, body)
 */
export function createServer(routes, { onError } = {}) {
  const compiled = routes.map((r) => {
    const keys = [];
    const regex = new RegExp(
      '^' +
        r.pattern
          .replace(/\/:([^/]+)/g, (_, k) => {
            keys.push(k);
            return '/([^/]+)';
          }) +
        '/?$'
    );
    return { method: r.method, regex, keys, handler: r.handler };
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const r of compiled) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      try {
        const body =
          req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
            ? await readJson(req)
            : {};
        await r.handler(req, res, params, body, url);
      } catch (e) {
        if (onError) return onError(e, req, res);
        const status = e.status || 500;
        fail(res, status, e.code || 'INTERNAL', e.message || '服务器内部错误');
      }
      return;
    }
    fail(res, 404, 'NOT_FOUND', `无此接口: ${req.method} ${url.pathname}`);
  });
}

// ---------- 服务间 HTTP 调用 ----------

/** 发起 JSON 请求，返回 { status, body }；网络错误抛出，由调用方决定降级策略 */
export async function call(method, url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  return randomUUID();
}
