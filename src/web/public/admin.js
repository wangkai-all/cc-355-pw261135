import { api, toast, esc, fmtTime, newRecordId, newBatchId } from './api.js';

const $ = (id) => document.getElementById(id);
let state = { clients: [], tasks: [], conflicts: [], selectedConflict: null };
const admin = (path, body) => (body === undefined ? api.get(path, { admin: true }) : api.post(path, body, { admin: true }));

// ---------- Tab 切换 ----------
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === 'sec-' + b.dataset.tab));
    refreshAll();
  })
);

// ---------- 总览：设备 + 统计 ----------
async function loadClients() {
  state.clients = await admin('/api/admin/clients');
  const rows = state.clients
    .map(
      (c) => `<tr>
        <td><b>${esc(c.client_id)}</b> <span class="muted">${esc(c.name)}</span><br/><span class="mono muted" style="font-size:11px">${esc('token: ' + c.client_id)}</span></td>
        <td>${c.status === 'online' ? '<span class="badge green">在线</span>' : '<span class="badge red">已切断</span>'}</td>
        <td class="mono">${fmtTime(c.last_seen_at)}</td>
        <td>${
          c.status === 'online'
            ? `<button class="small danger" data-disconnect="${c.client_id}">切断连接</button>`
            : `<button class="small" data-reconnect="${c.client_id}">恢复连接</button>`
        }</td>
      </tr>`
    )
    .join('');
  $('ov-clients').innerHTML = rows;
  document.querySelectorAll('[data-disconnect]').forEach((b) =>
    b.addEventListener('click', () => changeClientStatus(b.dataset.disconnect, false))
  );
  document.querySelectorAll('[data-reconnect]').forEach((b) =>
    b.addEventListener('click', () => changeClientStatus(b.dataset.reconnect, true))
  );
  $('ru-client').innerHTML = state.clients
    .map((c) => `<option value="${c.client_id}">${esc(c.client_id)} — ${esc(c.name)}</option>`)
    .join('');
}

async function changeClientStatus(clientId, reconnect) {
  const reason = prompt(reconnect ? '恢复连接的理由（记入审计）：' : '切断该设备连接的理由（记入审计）：', reconnect ? '现场恢复作业' : '疑似设备离线失控，暂停其接入');
  if (reason === null) return;
  try {
    await admin(`/api/admin/clients/${clientId}/${reconnect ? 'reconnect' : 'disconnect'}`, { reason });
    toast('操作成功并已审计', 'ok');
    loadClients();
  } catch (e) { toast(e.message, 'err'); }
}

async function loadStats() {
  const s = await admin('/api/admin/stats');
  const card = (n, label, color = '') =>
    `<div class="stat"><b style="color:var(--${color || 'accent'})">${n}</b><span>${esc(label)}</span></div>`;
  const html =
    card(s.canonical_points, '有有效基准版本的采样点', 'green') +
    card(s.accepted_records, '有效事实记录数(accepted)', 'accent') +
    card(s.records_by_status.conflict || 0, '待审/冲突中记录', 'amber') +
    card(s.open_conflicts, '待裁决冲突', 'red') +
    card(s.records_by_status.rejected || 0, '裁决未采纳(保留可追溯)', 'purple') +
    card(s.records_by_status.quarantined || 0, '隔离待核', 'red');
  $('ov-stats').innerHTML = html;
  $('rec-stats').innerHTML = html;
  $('conflict-dot').style.display = s.open_conflicts ? 'inline-block' : 'none';
  $('conflict-dot').textContent = s.open_conflicts;
}

// ---------- 任务管控 ----------
async function loadTasks() {
  state.tasks = await admin('/api/admin/tasks');
  $('task-view').innerHTML = state.tasks
    .map((t) => {
      const owner = t.owner;
      return `<div class="point-card">
        <div class="row">
          <b>${esc(t.code)}</b> ${esc(t.title)}
          <span class="badge ${t.lock_mode === 'whole' ? 'purple' : 'blue'}">${t.lock_mode === 'whole' ? '整任务锁定' : '细粒度领取'}</span>
          <span class="badge ${t.status === 'active' ? 'green' : 'amber'}">${esc(t.status)}</span>
          <span class="spacer"></span>
          <span class="muted" style="font-size:12px">当前归属：${owner ? esc(owner.client_name) : '无'}</span>
          <select id="reassign-who-${t.task_id}" style="max-width:200px">
            ${state.clients.map((c) => `<option value="${c.client_id}" ${owner?.client_id === c.client_id ? 'disabled' : ''}>转给 ${esc(c.client_id)}${owner?.client_id === c.client_id ? '（当前持有者）' : ''}</option>`).join('')}
          </select>
          <input id="reassign-why-${t.task_id}" placeholder="重分配理由" style="max-width:240px" />
          <button class="small warn" data-reassign-task="${t.task_id}">整任务重分配</button>
          <button class="small danger" data-close-task="${t.task_id}">关闭任务</button>
        </div>
        <table style="margin-top:8px"><thead><tr><th>点号</th><th>点位/参数</th><th>当前领取</th><th>细粒度重分配</th></tr></thead><tbody>
        ${t.points
          .map(
            (p) => `<tr>
              <td class="mono">${esc(p.code)}</td>
              <td>${esc(p.name)}<br/><span class="muted" style="font-size:11.5px">${esc(p.planned_parameter)}</span></td>
              <td>${p.claimed_by ? `<span class="badge ${p.claimed_by === owner?.client_id ? 'green' : 'red'}">${esc(p.claimed_by)}</span>` : '<span class="badge gray">无人</span>'}</td>
              <td class="row">
                <select id="rp-who-${p.point_id}" style="max-width:140px">
                  ${state.clients.map((c) => `<option value="${c.client_id}" ${p.claimed_by === c.client_id ? 'disabled' : ''}>${esc(c.client_id)}${p.claimed_by === c.client_id ? '（持有者）' : ''}</option>`).join('')}
                </select>
                <button class="small" data-reassign-point="${p.point_id}" data-task="${t.task_id}">仅重分配此点</button>
              </td>
            </tr>`
          )
          .join('')}
        </tbody></table>
      </div>`;
    })
    .join('');

  document.querySelectorAll('[data-reassign-task]').forEach((b) =>
    b.addEventListener('click', () => reassign(b.dataset.reassignTask, null))
  );
  document.querySelectorAll('[data-reassign-point]').forEach((b) =>
    b.addEventListener('click', () => reassign(b.dataset.task, [b.dataset.reassignPoint]))
  );
  document.querySelectorAll('[data-close-task]').forEach((b) =>
    b.addEventListener('click', async () => {
      const reason = prompt('关闭任务理由：', '采样与裁决全部完成');
      if (reason === null) return;
      await admin(`/api/admin/tasks/${b.dataset.closeTask}/close`, { reason });
      toast('任务已关闭并审计', 'ok');
      loadTasks();
    })
  );
}

async function reassign(taskId, pointIds) {
  const who = $(pointIds ? `rp-who-${pointIds[0]}` : `reassign-who-${taskId}`).value;
  const inputReason = pointIds ? null : $(`reassign-why-${taskId}`).value.trim();
  const reason = inputReason ||
    prompt('重分配理由（记入归属历史与审计）：', pointIds ? '细粒度改派：原设备离线，改由他人承接该点' : '原设备离线，整任务改派');
  if (!reason) return;
  try {
    await admin(`/api/admin/tasks/${taskId}/reassign`, { client_id: who, reason, point_ids: pointIds || undefined });
    toast('重分配完成：原归属已作废并保留历史，新归属生效', 'ok');
    loadTasks();
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- 冲突队列 ----------
async function loadConflicts() {
  const onlyOpen = $('cf-only-open').checked;
  state.conflicts = await admin('/api/admin/conflicts' + (onlyOpen ? '?status=open' : '?status=all'));
  $('conflict-list').innerHTML = state.conflicts
    .map(
      (c) => `<tr>
        <td class="mono">#${c.id}${c.followup_of ? `<br/><span class="muted" style="font-size:11px">后继于 #${c.followup_of}</span>` : ''}</td>
        <td class="mono">${esc(c.task_id)}<br/>${esc(c.point_id || '（整任务级）')}</td>
        <td><span class="badge amber">${esc(c.reason)}</span></td>
        <td>${c.status === 'open' ? '<span class="badge red">待裁决</span>' : `<span class="badge green">已裁决:${esc(c.decision)}</span>`}</td>
        <td>${c.candidate_count}</td>
        <td class="mono">${fmtTime(c.opened_at)}</td>
        <td>${c.decided_by ? esc(c.decided_by) : '—'}</td>
        <td><button class="small primary" data-open-conflict="${c.id}">审阅</button></td>
      </tr>`
    )
    .join('') || '<tr><td colspan="8" class="muted">没有冲突</td></tr>';
  document.querySelectorAll('[data-open-conflict]').forEach((b) =>
    b.addEventListener('click', () => openConflict(Number(b.dataset.openConflict)))
  );
}

async function openConflict(id) {
  const d = await admin(`/api/admin/conflicts/${id}`);
  state.selectedConflict = d;
  $('conflict-detail-card').style.display = '';
  $('conflict-detail').innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <span class="badge ${d.status === 'open' ? 'red' : 'green'}">${d.status}</span>
      <span class="badge amber">${esc(d.reason)}</span>
      <span class="mono muted">${esc(d.conflict_key)}</span>
      ${d.followup_of ? `<span class="badge purple">裁决后又来数据（后继 #${d.followup_of}）</span>` : ''}
    </div>
    <table><thead><tr><th>候选角色</th><th>来源设备</th><th>记录 ID</th><th>采样时间</th><th>状态</th><th>基准</th><th>虚构数据</th><th>操作</th></tr></thead><tbody>
    ${d.records
      .map(
        (r) => `<tr>
          <td><span class="badge ${r.candidate_role === 'incumbent' ? 'green' : r.candidate_role === 'manual' ? 'purple' : 'amber'}">${esc(r.candidate_role)}</span></td>
          <td><b>${esc(r.client_id)}</b></td>
          <td class="mono">${esc(r.record_id)}</td>
          <td class="mono">${fmtTime(r.sampled_at)}</td>
          <td>${esc(r.status)}</td>
          <td>${r.canonical ? '<span class="badge blue">当前基准</span>' : ''}</td>
          <td><pre class="json" style="max-height:120px;margin:0">${esc(JSON.stringify(JSON.parse(r.payload), null, 1))}</pre></td>
          <td>${
            d.status === 'open'
              ? `<button class="small primary" data-pick="${r.client_id}|${r.record_id}">采纳此条</button>`
              : ''
          }</td>
        </tr>`
      )
      .join('')}
    </tbody></table>
    ${
      d.status === 'open'
        ? `<div class="card" style="margin-top:12px;background:var(--panel2)">
            <label>裁决理由（必填，写入裁决历史与审计）</label>
            <input id="resolve-reason" placeholder="例如：迟到数据采样时间更晚且现场照片编号连续，采纳旧端数据；新承接者该点重测" />
            <div class="row" style="margin-top:10px">
              <button class="small primary" id="btn-resolve-accept">采纳所选候选</button>
              <button class="small warn" id="btn-resolve-merge">合并保留：现任仍为基准，迟到记录采纳为补充</button>
              <button class="small danger" id="btn-resolve-reject">全部不采纳（维持/留空基准，事实保留）</button>
              <button class="small" id="btn-resolve-manual">人工录入新版本…</button>
            </div>
          </div>`
        : ''
    }
    <details open><summary>裁决时间线（每个决定前后快照可追溯）</summary>
      <div class="timeline">
        ${d.resolutions
          .map(
            (r) => `<div class="ev">
              <span class="at">${fmtTime(r.at)}</span><br/>
              <b>${esc(r.action)}</b> by ${esc(r.decided_by)}
              ${r.winner_record_id ? `· 获胜记录 <span class="mono">${esc(r.winner_record_id)}</span>` : ''}<br/>
              <span class="muted">理由：${esc(r.reason)}</span>
              <details><summary class="muted">前后状态快照</summary>
                <pre class="json">${esc(JSON.stringify({ before: JSON.parse(r.before_snapshot), after: JSON.parse(r.after_snapshot) }, null, 1))}</pre>
              </details>
            </div>`
          )
          .join('') || '<p class="muted">尚无裁决</p>'}
      </div>
    </details>`;

  document.querySelectorAll('[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-pick]').forEach((x) => (x.style.outline = ''));
      b.style.outline = '2px solid var(--accent)';
      state.picked = b.dataset.pick.split('|');
    })
  );
  if (d.status === 'open') {
    $('btn-resolve-accept').onclick = () => resolve('accept_record');
    $('btn-resolve-merge').onclick = () => resolve('merge_keep_canonical');
    $('btn-resolve-reject').onclick = () => resolve('reject_all');
    $('btn-resolve-manual').onclick = manualResolve;
  }
}

async function resolve(action) {
  const reason = $('resolve-reason').value.trim();
  if (!reason) return toast('请填写裁决理由（强制留痕）', 'err');
  const body = { action, reason };
  if (action === 'accept_record') {
    if (!state.picked) return toast('请先在候选表中点选要采纳的记录', 'err');
    body.winner_client_id = state.picked[0];
    body.winner_record_id = state.picked[1];
  }
  try {
    await admin(`/api/admin/conflicts/${state.selectedConflict.id}/resolve`, body);
    toast('裁决完成，统计与基准版本已自动更新', 'ok');
    await openConflict(state.selectedConflict.id);
    loadConflicts();
    loadStats();
  } catch (e) { toast(e.message, 'err'); }
}

async function manualResolve() {
  const reason = $('resolve-reason').value.trim();
  if (!reason) return toast('请先填写裁决理由', 'err');
  const raw = prompt('粘贴人工版本的虚构测定 JSON：', JSON.stringify({ synthetic: true, measures: { pH: 7.2, 浊度: 12.4 } }));
  if (!raw) return;
  try {
    const payload = JSON.parse(raw);
    await admin(`/api/admin/conflicts/${state.selectedConflict.id}/resolve`, {
      action: 'manual_entry', reason, manual: { payload },
    });
    toast('人工版本已成为基准，候选事实保留可追溯', 'ok');
    await openConflict(state.selectedConflict.id);
    loadConflicts(); loadStats();
  } catch (e) { toast('JSON 解析失败或请求失败：' + e.message, 'err'); }
}

// ---------- 事实记录 ----------
async function loadRecordFilters() {
  if (!$('rf-task').options.length) {
    $('rf-task').innerHTML =
      '<option value="">全部任务</option>' +
      state.tasks.map((t) => `<option value="${t.task_id}">${esc(t.code)}</option>`).join('');
  }
}
async function loadRecords() {
  const params = new URLSearchParams();
  if ($('rf-task').value) params.set('task_id', $('rf-task').value);
  if ($('rf-status').value) params.set('status', $('rf-status').value);
  if ($('rf-point').value.trim()) params.set('point_id', $('rf-point').value.trim());
  const rows = await admin('/api/admin/records?' + params.toString());
  const badge = (s) =>
    ({ accepted: 'green', conflict: 'amber', rejected: 'red', quarantined: 'red', manual: 'purple' }[s] || 'gray');
  $('records-list').innerHTML = rows
    .map(
      (r) => `<tr>
        <td class="mono">${esc(r.record_id)}<br/><span class="muted" style="font-size:11px">批次 ${esc(r.batch_id)}</span></td>
        <td><b>${esc(r.client_id)}</b></td>
        <td class="mono">${esc(r.task_id)}<br/>${esc(r.point_id || '-')}</td>
        <td><span class="badge ${badge(r.status)}">${esc(r.status)}</span></td>
        <td>${r.accepted ? '✅' : '—'}</td>
        <td>${r.canonical ? '<span class="badge blue">基准</span>' : (r.superseded_at ? '已降级' : '—')}</td>
        <td class="mono">${fmtTime(r.sampled_at)}</td>
        <td><pre class="json" style="max-height:100px;margin:0;max-width:260px">${esc(JSON.stringify(JSON.parse(r.payload), null, 1))}</pre></td>
        <td style="max-width:180px">${esc(r.note || '')}${r.superseded_at ? `<br/><span class="muted" style="font-size:11px">降级于 ${fmtTime(r.superseded_at)}</span>` : ''}</td>
      </tr>`
    )
    .join('') || '<tr><td colspan="9" class="muted">无记录</td></tr>';
}

// ---------- 审计 ----------
async function loadAudit() {
  const render = (el, rows) => {
    $(el).innerHTML = rows
      .map(
        (r) => `<div class="line"><span class="t">${fmtTime(r.at)}</span> <b>${esc(r.action)}</b>
          <span class="muted">${esc(r.actor)} → ${esc(r.entity)}/${esc(r.entity_id)}</span>
          <pre class="json" style="max-height:120px;margin:2px 0 6px">${esc(r.detail)}</pre></div>`
      )
      .join('') || '<div class="muted">暂无</div>';
  };
  render('audit-task', await admin('/api/admin/audit?source=task'));
  render('audit-ingest', await admin('/api/admin/audit'));
}

// ---------- 补传 ----------
function fillReuploadTemplate() {
  const clientId = $('ru-client').value;
  const tpl = {
    batch_id: newBatchId(),
    client_id: clientId,
    records: [
      {
        record_id: newRecordId(),
        task_id: 'task-lake',
        point_id: 'pt-lake-s01',
        sampled_at: new Date().toISOString(),
        payload: { synthetic: true, measures: { pH: 7.31, 浊度: 18.6, 溶解氧: 6.8 }, note: '管理员协助补传的虚构数据', device: clientId },
      },
    ],
  };
  $('ru-json').value = JSON.stringify(tpl, null, 2);
}

async function doReupload() {
  let batch;
  try {
    batch = JSON.parse($('ru-json').value);
  } catch { return toast('批次 JSON 格式错误', 'err'); }
  const client = state.clients.find((c) => c.client_id === $('ru-client').value);
  try {
    const data = await admin('/api/admin/inbox/reupload', {
      device_token: { 'dev-a': 'token-device-a', 'dev-b': 'token-device-b' }[client.client_id],
      client_id: client.client_id,
      reason: $('ru-reason').value || '管理员协助补传',
      batch,
    });
    $('ru-result').textContent = JSON.stringify(data, null, 2);
    toast('补传处理完成（冲突已自动入队，统计已更新）', 'ok');
    loadStats(); loadConflicts(); loadRecords();
  } catch (e) {
    $('ru-result').textContent = '失败：' + e.message + '\n' + JSON.stringify(e.detail || {}, null, 2);
    toast(e.message, 'err');
  }
}

// ---------- 全局刷新 ----------
async function refreshAll() {
  try {
    await loadClients();
    await loadStats();
    await loadRecordFilters();
    await loadTasks();
    await loadConflicts();
    await loadRecords();
    await loadAudit();
  } catch (e) {
    toast('刷新失败：' + e.message + '（请确认三个服务都已启动）', 'err');
  }
}

$('btn-query-records').onclick = loadRecords;
$('btn-refresh-stats').onclick = loadStats;
$('btn-refresh-conflicts').onclick = loadConflicts;
$('btn-audit-task').onclick = loadAudit;
$('btn-audit-ingest').onclick = loadAudit;
$('btn-ru-template').onclick = fillReuploadTemplate;
$('btn-reupload').onclick = doReupload;
$('btn-close-detail').onclick = () => ($('conflict-detail-card').style.display = 'none');
$('cf-only-open').onchange = loadConflicts;

refreshAll();
setInterval(loadStats, 6000);
setInterval(loadConflicts, 10000);
