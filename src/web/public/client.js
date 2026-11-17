import { api, toast, esc, fmtTime, currentDevice, newRecordId, newBatchId } from './api.js';

const device = currentDevice();
const LS = {
  settings: `sampler:${device.clientId}:settings`,
  outbox: `sampler:${device.clientId}:outbox`,
  records: `sampler:${device.clientId}:records`,
};
const $ = (id) => document.getElementById(id);
let tasksCache = [];

// ---------- 本地存储 ----------
const load = (k, d) => JSON.parse(localStorage.getItem(k) ?? JSON.stringify(d));
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
let settings = load(LS.settings, { offline: false, dropReceipt: false, autoSync: true });
let outbox = load(LS.outbox, []);

function log(msg, kind = '') {
  const el = $('log');
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  line.innerHTML = `<span class="t">${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span> ${esc(msg)}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ---------- 网络层：离线开关拦截；回执丢弃开关模拟"请求成功但客户端没收到" ----------
async function netGet(path) {
  if (settings.offline) throw Object.assign(new Error('本机处于离线模式'), { offline: true });
  return api.get(path, { token: device.token });
}
async function netPost(path, body) {
  if (settings.offline) throw Object.assign(new Error('本机处于离线模式'), { offline: true });
  try {
    const data = await api.post(path, body, { token: device.token });
    if (settings.dropReceipt && path === '/api/uploads') {
      throw Object.assign(new Error('模拟：服务器已处理，但成功回执在网络中丢失'), { receiptLost: true });
    }
    return data;
  } catch (e) {
    // 同样模拟丢弃：网络错误场景下无法区分，交给发件箱重试做幂等
    throw e;
  }
}

// ---------- 任务与表单 ----------
async function refreshTasks() {
  try {
    const data = await netGet('/api/my/tasks');
    tasksCache = data.tasks;
    $('conn-badge').innerHTML = `连接: <b style="color:var(--green)">在线</b>`;
    $('server-badge').textContent = `服务器眼中本端状态: ${data.client.status}`;
    $('server-badge').className = 'badge ' + (data.client.status === 'online' ? 'green' : 'red');
    renderTasks();
    renderTaskSelect();
    refreshRecordStatuses();
  } catch (e) {
    $('conn-badge').innerHTML = settings.offline
      ? '连接: <b style="color:var(--amber)">离线（本机开关）</b>'
      : '连接: <b style="color:var(--red)">不可达</b>';
    log(`刷新任务失败：${e.message}`, 'warn');
  }
}

function statusBadge(rec) {
  const map = {
    accepted: ['green', '已采纳'], conflict: ['amber', '审阅队列'], rejected: ['red', '裁决未采纳'],
    quarantined: ['red', '隔离待核'], manual: ['purple', '人工版本'], duplicate: ['gray', '重复'],
  };
  const [cls, label] = map[rec.status] || ['gray', rec.status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderTaskSelect() {
  const taskSel = $('sel-task');
  const prev = taskSel.value;
  taskSel.innerHTML = tasksCache
    .map((t) => `<option value="${t.task_id}">${esc(t.code)}｜${esc(t.title)}（${t.lock_mode === 'whole' ? '整任务锁定' : '细粒度领取'}）</option>`)
    .join('');
  if (prev && tasksCache.some((t) => t.task_id === prev)) taskSel.value = prev;
  renderPointSelect();
}

function renderPointSelect() {
  const task = tasksCache.find((t) => t.task_id === $('sel-task').value);
  const pointSel = $('sel-point');
  if (!task) return;
  pointSel.innerHTML = task.points
    .map((p) => `<option value="${p.point_id}">${esc(p.code)} ${esc(p.name)}${p.claimed_by ? `（${p.claimed_by === device.clientId ? '我已领取' : '他人领取:' + p.claimed_by}）` : '（无人领取）'}</option>`)
    .join('');
  renderMeasureInputs();
  renderPointInfo();
}

function renderPointInfo() {
  const task = tasksCache.find((t) => t.task_id === $('sel-task').value);
  const p = task?.points.find((x) => x.point_id === $('sel-point').value);
  if (!p) return;
  $('point-info').innerHTML = `计划参数：<b>${esc(p.planned_parameter)}</b>　归属：${
    task.lock_mode === 'whole'
      ? `整任务锁定 → ${task.owner_client_id ? esc(task.owner_name) + (task.locked_by_me ? '（我）' : '（他人，上传将进冲突队列）') : '未分配'}`
      : p.claimed_by
        ? p.claimed_by_me
          ? '<span class="badge green">我已领取，可直接上传</span>'
          : `<span class="badge red">已被 ${esc(p.claimed_by)} 领取，我的数据将进审阅队列</span>`
        : '<span class="badge amber">无人领取，首次上传自动领取</span>'
  }`;
}

const PARAM_RANGES = {
  pH: [6.5, 8.5, 2], 浊度: [2, 40, 1], 溶解氧: [4, 11, 2], 氨氮: [0.05, 1.5, 3],
  总磷: [0.02, 0.4, 3], 土壤pH: [5, 8, 2], 有机质: [5, 45, 2], 含水率: [8, 38, 1], 全氮: [0.3, 3.5, 3],
};
function fakeValue(name) {
  const [lo, hi, digits] = PARAM_RANGES[name] || [1, 100, 2];
  return Number((lo + Math.random() * (hi - lo)).toFixed(digits));
}

function renderMeasureInputs(fill = false) {
  const task = tasksCache.find((t) => t.task_id === $('sel-task').value);
  const p = task?.points.find((x) => x.point_id === $('sel-point').value);
  if (!p) return;
  const names = p.planned_parameter.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
  $('measure-inputs').innerHTML = names
    .map((n) => `<div class="row" style="margin-bottom:6px">
        <span style="min-width:90px" class="muted">${esc(n)}</span>
        <input data-param="${esc(n)}" class="measure" placeholder="虚构数值" />
        <span class="muted" style="font-size:12px">（虚构单位，演示用）</span>
      </div>`)
    .join('');
  if (fill) document.querySelectorAll('.measure').forEach((i) => (i.value = fakeValue(i.dataset.param)));
}

function renderTasks() {
  $('tasks-view').innerHTML = tasksCache
    .map((t) => {
      const mine = t.locked_by_me;
      return `<div class="point-card">
        <div class="row">
          <b>${esc(t.code)}</b> ${esc(t.title)}
          <span class="badge ${t.lock_mode === 'whole' ? 'purple' : 'blue'}">${t.lock_mode === 'whole' ? '整任务锁定' : '细粒度领取'}</span>
          <span class="badge ${t.status === 'active' ? 'green' : 'amber'}">${esc(t.status)}</span>
          <span class="spacer"></span>
          <span class="muted" style="font-size:12px">当前整任务归属：${t.owner_name ? esc(t.owner_name) + (mine ? '（我）' : '') : '无'}</span>
          ${t.lock_mode === 'whole' && !mine ? `<button class="small warn" data-claim-task="${t.task_id}">尝试锁定整任务</button>` : ''}
        </div>
        <table style="margin-top:8px"><thead><tr><th>点号</th><th>点位</th><th>计划参数</th><th>领取状态</th><th></th></tr></thead><tbody>
        ${t.points
          .map(
            (p) => `<tr>
              <td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td><td>${esc(p.planned_parameter)}</td>
              <td>${
                p.claimed_by
                  ? p.claimed_by_me
                    ? '<span class="badge green">我已领取</span>'
                    : `<span class="badge red">${esc(p.claimed_by)} 持有</span>`
                  : '<span class="badge gray">无人领取</span>'
              }</td>
              <td>${
                t.lock_mode === 'points' && !p.claimed_by_me
                  ? `<button class="small" data-claim-point="${p.point_id}" data-task="${t.task_id}">领取该点</button>`
                  : ''
              }</td>
            </tr>`
          )
          .join('')}
        </tbody></table>
      </div>`;
    })
    .join('');
  document.querySelectorAll('[data-claim-task]').forEach((b) =>
    b.addEventListener('click', () => claim(b.dataset.claimTask, null))
  );
  document.querySelectorAll('[data-claim-point]').forEach((b) =>
    b.addEventListener('click', () => claim(b.dataset.task, b.dataset.claimPoint))
  );
}

async function claim(taskId, pointId) {
  try {
    await netPost(`/api/my/tasks/${taskId}/claim`, pointId ? { point_id: pointId } : {});
    log(`领取成功：${pointId || '整任务'}`, 'ok');
    refreshTasks();
  } catch (e) {
    log(`领取被拒绝：${e.message}（${e.code || ''}）`, 'err');
    toast('领取失败：' + e.message, 'err');
  }
}

// ---------- 发件箱 ----------
function renderOutbox() {
  $('outbox-count').textContent = outbox.length;
  $('outbox-body').innerHTML = outbox
    .map(
      (r) => `<tr>
        <td class="mono">${esc(r.record_id.slice(0, 16))}</td>
        <td class="mono">${esc(r.point_id || '-')}</td>
        <td>${fmtTime(r.sampled_at)}</td>
        <td>${
          r.state === 'pending'
            ? '<span class="badge amber">待发送</span>'
            : r.state === 'inflight'
              ? '<span class="badge blue">发送中</span>'
              : r.state === 'sent'
                ? '<span class="badge green">服务器已确认</span>'
                : `<span class="badge red">失败:${esc(r.error || '')}</span>`
        }</td>
        <td>${r.state !== 'sent' ? `<button class="small danger" data-del="${r.record_id}">删除</button>` : ''}</td>
      </tr>`
    )
    .join('');
  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      outbox = outbox.filter((r) => r.record_id !== b.dataset.del);
      save(LS.outbox, outbox);
      renderOutbox();
    })
  );
}

function saveRecord() {
  const task = tasksCache.find((t) => t.task_id === $('sel-task').value);
  const point = task?.points.find((p) => p.point_id === $('sel-point').value);
  if (!task || !point) return toast('请先选择任务和采样点', 'err');
  const measures = {};
  document.querySelectorAll('.measure').forEach((i) => {
    if (i.value !== '') measures[i.dataset.param] = Number(i.value);
  });
  if (!Object.keys(measures).length) return toast('请至少填写一个虚构测定值', 'err');
  const rec = {
    record_id: newRecordId(),
    task_id: task.task_id,
    point_id: point.point_id,
    sampled_at: new Date().toISOString(),
    payload: {
      synthetic: true, // 明确标记虚构数据
      measures,
      note: $('inp-note').value || null,
      device: device.clientId,
    },
    state: 'pending',
  };
  outbox.push(rec);
  save(LS.outbox, outbox);
  renderOutbox();
  log(`记录 ${rec.record_id} 已保存到发件箱（${settings.offline ? '离线，等待恢复' : '在线，可立即同步'}）`, 'ok');
  toast('记录已保存');
}

// 同步：把整个发件箱打成一个批次；record_id 稳定 → 重复提交天然幂等
async function syncOutbox() {
  const pending = outbox.filter((r) => r.state !== 'sent');
  if (!pending.length) {
    toast('发件箱没有待同步记录');
    return;
  }
  if (settings.offline) return toast('当前离线，无法同步', 'warn');
  const batch = {
    batch_id: newBatchId(),
    client_id: device.clientId,
    records: pending.map(({ state, ...r }) => r),
  };
  pending.forEach((r) => (r.state = 'inflight'));
  renderOutbox();
  log(`开始同步批次 ${batch.batch_id}，含 ${batch.records.length} 条记录…`);
  try {
    const data = await netPost('/api/uploads', batch);
    const replay = data.replay ? '（服务器识别为重放批次，返回原回执）' : '';
    for (const rr of data.receipt.records) {
      const local = outbox.find((r) => r.record_id === rr.record_id);
      if (!local) continue;
      if (rr.status === 'accepted') local.state = 'sent';
      else if (rr.status === 'conflict') {
        local.state = 'sent'; // 服务器已收到且入审阅队列，对本端而言投递成功
        local.conflict_id = rr.conflict_id;
      } else if (rr.status === 'quarantined') local.state = 'sent';
      else if (rr.status === 'duplicate') local.state = 'sent';
      local.server = rr;
    }
    save(LS.outbox, outbox);
    log(`批次处理完成${replay}：` + data.receipt.records.map((r) => `${r.record_id.slice(0, 8)}→${r.status}${r.conflict_id ? ' #' + r.conflict_id : ''}`).join('，'), 'ok');
    toast('同步完成（见日志中的逐条处理结果）', 'ok');
  } catch (e) {
    pending.forEach((r) => {
      if (r.state === 'inflight') {
        r.state = 'pending';
        r.error = e.receiptLost ? '回执丢失，将幂等重传' : e.message;
      }
    });
    log(`同步失败：${e.message}。记录保留在发件箱，稍后重试（record_id 不变，不会产生重复事实）`, 'err');
    toast(e.message, 'err');
  }
  save(LS.outbox, outbox);
  renderOutbox();
  refreshRecordStatuses();
}

async function refreshRecordStatuses() {
  try {
    const rows = await netGet('/api/my/records');
    save(LS.records, rows);
    $('records-body').innerHTML = rows
      .map(
        (r) => `<tr>
          <td class="mono">${esc(r.record_id)}</td>
          <td class="mono">${esc(r.point_id || '-')}</td>
          <td>${statusBadge(r)}</td>
          <td>${r.accepted ? '<span class="badge green">有效</span>' : '<span class="badge gray">否</span>'}
              ${r.canonical ? '<span class="badge blue">当前基准</span>' : ''}</td>
          <td>${r.conflict_id ? `<span class="badge amber">#${r.conflict_id}</span>` : '—'}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5" class="muted">暂无</td></tr>';
  } catch {
    /* 离线时静默，保留上次快照 */
  }
}

// ---------- 心跳：被管理员切断后可见 ----------
async function heartbeat() {
  if (settings.offline) return;
  try {
    await api.post('/api/devices/heartbeat', {}, { token: device.token });
  } catch (e) {
    if (e.status === 403) {
      $('server-badge').className = 'badge red';
      $('server-badge').textContent = '连接已被管理员切断（上传将被拒绝并进审阅流程）';
      log('服务器拒绝心跳：连接已被管理员切断', 'err');
    }
  }
}

// ---------- 事件绑定 ----------
function bind() {
  $('device-badge').textContent = `${device.label}（${device.clientId}）`;
  $('sw-offline').checked = settings.offline;
  $('sw-drop').checked = settings.dropReceipt;
  $('sw-autosync').checked = settings.autoSync;

  $('sw-offline').onchange = (e) => {
    settings.offline = e.target.checked;
    save(LS.settings, settings);
    log(e.target.checked ? '已切换为离线模式：请求全部在本机拦截' : '恢复在线', 'warn');
    if (!settings.offline) {
      refreshTasks();
      if (settings.autoSync) syncOutbox();
    }
  };
  $('sw-drop').onchange = (e) => {
    settings.dropReceipt = e.target.checked;
    save(LS.settings, settings);
    log(e.target.checked ? '开启"回执丢弃"模拟：下一次上传服务器会处理成功，但本端收不到回执' : '关闭回执丢弃模拟', 'warn');
  };
  $('sw-autosync').onchange = (e) => {
    settings.autoSync = e.target.checked;
    save(LS.settings, settings);
  };
  $('btn-sync').onclick = syncOutbox;
  $('btn-refresh').onclick = refreshTasks;
  $('btn-save').onclick = saveRecord;
  $('btn-fill').onclick = () => renderMeasureInputs(true);
  $('sel-task').onchange = renderPointSelect;
  $('sel-point').onchange = () => { renderPointInfo(); renderMeasureInputs(); };
  $('btn-clear-sent').onclick = () => {
    outbox = outbox.filter((r) => r.state !== 'sent');
    save(LS.outbox, outbox); renderOutbox();
  };
  $('btn-clear-all').onclick = () => {
    if (confirm('确认清空本机发件箱？（服务器已接收的事实记录不受影响）')) {
      outbox = []; save(LS.outbox, outbox); renderOutbox();
    }
  };
}

bind();
renderOutbox();
refreshTasks();
heartbeat();
setInterval(heartbeat, 15000);
setInterval(() => { if (!settings.offline) refreshRecordStatuses(); }, 8000);
