// 前端共享工具：API 调用、设备配置、提示
const ADMIN_TOKEN = 'admin-token-fictional';

export function toast(msg, kind = '') {
  const wrap =
    document.querySelector('.toast-wrap') ||
    Object.assign(document.createElement('div'), { className: 'toast-wrap' });
  if (!wrap.parentElement) document.body.appendChild(wrap);
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function request(path, { method = 'GET', token, admin = false, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-client-token'] = token;
  if (admin) headers['x-admin-token'] = ADMIN_TOKEN;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({ ok: false, error: { message: '非 JSON 响应' } }));
  if (!res.ok || json.ok === false) {
    const err = new Error(json?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.error?.code;
    err.detail = json?.error;
    throw err;
  }
  return json.data;
}

export const api = {
  get: (p, opts) => request(p, opts),
  post: (p, body, opts) => request(p, { ...opts, method: 'POST', body }),
};

// 设备配置：?c=dev-a / dev-b，对应种子数据中的虚构令牌
export const DEVICES = {
  'dev-a': { clientId: 'dev-a', token: 'token-device-a', label: '采样终端-甲' },
  'dev-b': { clientId: 'dev-b', token: 'token-device-b', label: '采样终端-乙' },
};

export function currentDevice() {
  const id = new URLSearchParams(location.search).get('c') || 'dev-a';
  return DEVICES[id] || DEVICES['dev-a'];
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

// 生成稳定的客户端记录 ID（离线生成，重传不变 → 服务端幂等去重的基础）
export function newRecordId() {
  return 'rec-' + crypto.randomUUID().slice(0, 12);
}
export function newBatchId() {
  return 'batch-' + crypto.randomUUID().slice(0, 12);
}
