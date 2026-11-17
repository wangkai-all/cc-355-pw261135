// 端到端测试：覆盖离线补传、重分配冲突、幂等重放、裁决中追加数据、裁决后统计等
// 运行前自动重置两个数据库并启动三个服务；测试结束自动关闭。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, uuid } from '../src/shared/http.js';
import { PORTS, HOST, DATA_DIR } from '../src/shared/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WEB = `http://${HOST}:${PORTS.WEB}`;
const TOKEN_A = 'token-device-a';
const TOKEN_B = 'token-device-b';
const ADMIN = { 'x-admin-token': 'admin-token-fictional' };

const rec = (taskId, pointId, measures) => ({
  record_id: 'rec-' + uuid().slice(0, 12),
  task_id: taskId,
  point_id: pointId,
  sampled_at: new Date().toISOString(),
  payload: { synthetic: true, measures, note: '自动化测试虚构数据' },
});
const upload = async (token, batch) => (await call('POST', `http://${HOST}:${PORTS.INGEST}/api/uploads`, batch, { 'x-client-token': token })).body;
const adminPost = (p, body) => call('POST', `http://${HOST}:${PORTS.INGEST}${p}`, body, ADMIN);
const adminPostTask = (p, body) => call('POST', `http://${HOST}:${PORTS.TASK}${p}`, body, ADMIN);
const adminGet = (p, port = PORTS.INGEST) => call('GET', `http://${HOST}:${port}${p}`, undefined, ADMIN);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitReady = async (port, n = 40) => {
  for (let i = 0; i < n; i++) {
    try {
      await call('GET', `http://${HOST}:${port}/health`);
      return;
    } catch {
      await wait(150);
    }
  }
  throw new Error(`端口 ${port} 服务未就绪`);
};

let children = [];
before(async () => {
  // 清理旧数据库文件
  for (const f of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  // 种子
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/seed.js')], { cwd: ROOT, stdio: 'ignore' });
  const svc = [
    ['src/task/server.js', PORTS.TASK],
    ['src/ingest/server.js', PORTS.INGEST],
    ['src/web/server.js', PORTS.WEB],
  ];
  children = svc.map(([f]) => spawn(process.execPath, [path.join(ROOT, f)], { stdio: 'ignore' }));
  await waitReady(PORTS.INGEST);
  await waitReady(PORTS.TASK);
  await waitReady(PORTS.WEB);
});

after(() => children.forEach((c) => c.kill('SIGTERM')));

describe('场景 1：设备甲在线正常上传，自动采纳为基准', () => {
  test('1.1 整任务锁定任务，归属者上传 → accepted+canonical', async () => {
    const r1 = rec('task-lake', 'pt-lake-s01', { pH: 7.1, 浊度: 10.2, 溶解氧: 7.4 });
    const res = await upload(TOKEN_A, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-a', records: [r1] });
    assert.equal(res.ok, true);
    assert.equal(res.data.receipt.records[0].status, 'accepted');
    assert.equal(res.data.receipt.records[0].canonical, true);
    const stats = (await adminGet('/api/admin/stats')).body.data;
    assert.equal(stats.canonical_points, 1);
  });

  test('1.2 细粒度任务，无人领取的点首次上传自动领取并采纳', async () => {
    const r1 = rec('task-forest', 'pt-forest-f03', { 有机质: 22.4, 全氮: 1.2 });
    const res = await upload(TOKEN_A, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-a', records: [r1] });
    assert.equal(res.data.receipt.records[0].status, 'accepted');
  });
});

describe('场景 2：设备甲离线，管理员整任务重分配给设备乙，乙完成采样', () => {
  test('2.1 切断甲并把整任务 lake 转给乙（归属历史保留）', async () => {
    const d = await adminPostTask('/api/admin/clients/dev-a/disconnect', { reason: '测试：设备甲离线失联' });
    assert.equal(d.body.ok, true);
    const r = await adminPostTask('/api/admin/tasks/task-lake/reassign', {
      client_id: 'dev-b', reason: '测试：甲离线，整任务改派乙',
    });
    assert.equal(r.body.data.owner.client_id, 'dev-b');
    // 甲的原归属记录仍在（revoked）
    const hist = (await call('GET', `http://${HOST}:${PORTS.TASK}/api/admin/audit?entity=task&entity_id=task-lake`, undefined, ADMIN)).body.data;
    assert.ok(hist.some((h) => h.action === 'reassign-task'));
  });

  test('2.2 被切断的设备甲心跳被拒', async () => {
    const hb = await call('POST', `http://${HOST}:${PORTS.TASK}/api/devices/heartbeat`, {}, { 'x-client-token': TOKEN_A });
    assert.equal(hb.status, 403);
    assert.equal(hb.body.error.code, 'DISCONNECTED');
  });

  test('2.3 设备乙在同一点位上传新成果 → 乙的记录成为基准，甲的旧记录降级保留', async () => {
    const r1 = rec('task-lake', 'pt-lake-s01', { pH: 7.4, 浊度: 14.0, 溶解氧: 6.1 });
    const res = await upload(TOKEN_B, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-b', records: [r1] });
    assert.equal(res.data.receipt.records[0].status, 'accepted');
    const rows = (await adminGet("/api/admin/records?point_id=pt-lake-s01")).body.data;
    const canon = rows.filter((x) => x.canonical === 1);
    assert.equal(canon.length, 1);
    assert.equal(canon[0].client_id, 'dev-b');
    assert.ok(rows.some((x) => x.client_id === 'dev-a' && x.canonical === 0)); // 甲的事实没丢
  });
});

describe('场景 3：旧端恢复补传 → 不丢真实采样也不覆盖新成果，进入冲突队列', () => {
  test('3.1 甲恢复连接后补传同点数据 → 进 open 冲突，乙的基准不受影响', async () => {
    // 先恢复连接（模拟设备回到有网环境；即使不恢复，被切断时数据同样进队列）
    await adminPostTask('/api/admin/clients/dev-a/reconnect', { reason: '测试：设备甲恢复' });
    const late = rec('task-lake', 'pt-lake-s01', { pH: 6.9, 浊度: 9.8, 溶解氧: 8.2 });
    const res = await upload(TOKEN_A, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-a', records: [late] });
    const rr = res.data.receipt.records[0];
    assert.equal(rr.status, 'conflict');
    assert.ok(rr.conflict_id > 0);
    // 乙仍是基准
    const rows = (await adminGet("/api/admin/records?point_id=pt-lake-s01")).body.data;
    assert.equal(rows.find((x) => x.canonical === 1).client_id, 'dev-b');
    // 甲的迟到记录仍在库（status=conflict）
    assert.ok(rows.some((x) => x.client_id === 'dev-a' && x.status === 'conflict'));
    return { conflictId: rr.conflict_id, lateId: late.record_id };
  });
});

describe('场景 4：回执丢失与重复提交的幂等', () => {
  test('4.1 同一批次重传（回执丢失）→ replay=true，返回冻结回执，不产生重复数据', async () => {
    const r1 = rec('task-forest', 'pt-forest-f04', { 含水率: 21.3, 全氮: 0.9 });
    const batch = { batch_id: 'batch-fixed-001', client_id: 'dev-a', records: [r1] };
    const first = await upload(TOKEN_A, batch);
    assert.equal(first.data.replay, false);
    const second = await upload(TOKEN_A, batch);
    assert.equal(second.data.replay, true);
    assert.deepEqual(second.data.receipt.records[0].record_id, r1.record_id);
  });

  test('4.2 同 record_id 换批次再传 → duplicate，关联首次入库', async () => {
    const r1 = rec('task-forest', 'pt-forest-f05', { '土壤pH': 6.2, 有机质: 30.1, 全氮: 2.2 });
    await upload(TOKEN_A, { batch_id: 'b1-' + uuid().slice(0, 6), client_id: 'dev-a', records: [r1] });
    const again = await upload(TOKEN_A, { batch_id: 'b2-' + uuid().slice(0, 6), client_id: 'dev-a', records: [r1] });
    assert.equal(again.data.receipt.records[0].status, 'duplicate');
    const rows = (await adminGet(`/api/admin/records?point_id=pt-forest-f05`)).body.data;
    assert.equal(rows.length, 1);
  });
});

describe('场景 5：裁决过程中再次来数据 → 追加候选，不覆盖不丢弃', () => {
  test('5.1 open 冲突期间甲再补一条 → 候选数增加，冲突仍只有一个 open', async () => {
    const list = (await adminGet('/api/admin/conflicts?status=open')).body.data;
    const c = list.find((x) => x.point_id === 'pt-lake-s01');
    assert.ok(c, '应当存在 S01 的 open 冲突');
    const before = (await adminGet(`/api/admin/conflicts/${c.id}`)).body.data;
    const another = rec('task-lake', 'pt-lake-s01', { pH: 7.0, 浊度: 11.1, 溶解氧: 7.7 });
    const up = await upload(TOKEN_A, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-a', records: [another] });
    assert.equal(up.data.receipt.records[0].status, 'conflict');
    assert.equal(up.data.receipt.records[0].conflict_id, c.id);
    const after = (await adminGet(`/api/admin/conflicts/${c.id}`)).body.data;
    assert.equal(after.records.length, before.records.length + 1);
    assert.ok(after.records.some((r) => r.record_id === another.record_id));
  });
});

describe('场景 6：四种裁决动作与统计联动', () => {
  let conflictId;
  test('6.1 采纳甲的迟到记录 → 甲成为基准，乙的记录降级但保留', async () => {
    const list = (await adminGet('/api/admin/conflicts?status=open')).body.data;
    conflictId = list.find((x) => x.point_id === 'pt-lake-s01').id;
    const detail = (await adminGet(`/api/admin/conflicts/${conflictId}`)).body.data;
    const winner = detail.records.find((r) => r.client_id === 'dev-a' && r.candidate_role !== 'incumbent');
    const res = await adminPost(`/api/admin/conflicts/${conflictId}/resolve`, {
      action: 'accept_record', reason: '测试裁决：甲的现场样本时间戳更早且连续，采纳甲',
      winner_record_id: winner.record_id, winner_client_id: winner.client_id,
    });
    assert.equal(res.body.data.status, 'resolved');
    const rows = (await adminGet("/api/admin/records?point_id=pt-lake-s01")).body.data;
    assert.equal(rows.find((x) => x.canonical === 1).client_id, 'dev-a');
    assert.ok(rows.some((x) => x.client_id === 'dev-b' && x.status === 'rejected'));
  });

  test('6.2 裁决后又来数据 → 新建后继冲突并带 followup_of', async () => {
    // 管理员把该点的后续作业改派给乙（乙成为现任承接者），甲又补来迟到数据
    await adminPostTask('/api/admin/tasks/task-lake/reassign', {
      client_id: 'dev-b', reason: '测试：裁决后该点改由乙继续监测', point_ids: ['pt-lake-s01'],
    });
    const late2 = rec('task-lake', 'pt-lake-s01', { pH: 7.2, 浊度: 13.3, 溶解氧: 6.6 });
    const up = await upload(TOKEN_A, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-a', records: [late2] });
    assert.equal(up.data.receipt.records[0].status, 'conflict');
    const newId = up.data.receipt.records[0].conflict_id;
    const c = (await adminGet(`/api/admin/conflicts/${newId}`)).body.data;
    assert.equal(c.followup_of, conflictId);
    assert.equal(c.reason, 'post_resolution_new_data');
    // 合并保留裁决：乙持有的现任基准不变，甲的迟到记录采纳为补充事实
    const merge = await adminPost(`/api/admin/conflicts/${newId}/resolve`, {
      action: 'merge_keep_canonical', reason: '测试：两版数据都保留，现任基准不变',
    });
    assert.equal(merge.body.data.status, 'resolved');
    const rows = (await adminGet("/api/admin/records?point_id=pt-lake-s01")).body.data;
    assert.equal(rows.find((x) => x.canonical === 1).client_id, 'dev-a'); // 6.1 裁决的基准不变
    assert.ok(rows.some((x) => x.record_id === late2.record_id && x.accepted === 1 && x.canonical === 0));
  });

  test('6.3 人工录入裁决 → 人工版本成为基准', async () => {
    // 制造一个新冲突：细粒度点 F03 改派给乙后，甲再传
    await adminPostTask('/api/admin/tasks/task-forest/reassign', {
      client_id: 'dev-b', reason: '测试：F03 细粒度改派', point_ids: ['pt-forest-f03'],
    });
    const late = rec('task-forest', 'pt-forest-f03', { 有机质: 19.0, 全氮: 1.0 });
    const up = await upload(TOKEN_A, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-a', records: [late] });
    const cid = up.data.receipt.records[0].conflict_id;
    const res = await adminPost(`/api/admin/conflicts/${cid}/resolve`, {
      action: 'manual_entry', reason: '测试：两份数据都存疑，采用人工复核版本',
      manual: { payload: { synthetic: true, measures: { 有机质: 21.0, 全氮: 1.1 } } },
    });
    assert.equal(res.body.data.decision, 'manual_entry');
    const rows = (await adminGet("/api/admin/records?point_id=pt-forest-f03")).body.data;
    assert.equal(rows.find((x) => x.canonical === 1).client_id, 'admin');
  });

  test('6.4 reject_all：无基准点全部不采纳 → 该点无 canonical，事实仍可查', async () => {
    // F02 是甲已领取的点；改派给乙，甲补传产生冲突，然后 reject_all
    await adminPostTask('/api/admin/tasks/task-forest/reassign', {
      client_id: 'dev-b', reason: '测试：F02 改派', point_ids: ['pt-forest-f02'],
    });
    const late = rec('task-forest', 'pt-forest-f02', { '土壤pH': 5.9, 含水率: 25.0 });
    const up = await upload(TOKEN_A, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-a', records: [late] });
    const cid = up.data.receipt.records[0].conflict_id;
    await adminPost(`/api/admin/conflicts/${cid}/resolve`, {
      action: 'reject_all', reason: '测试：迟到数据无效，且该点暂无其他基准',
    });
    const rows = (await adminGet("/api/admin/records?point_id=pt-forest-f02")).body.data;
    assert.equal(rows.filter((x) => x.canonical === 1).length, 0);
    assert.ok(rows.some((x) => x.status === 'rejected')); // 事实保留
  });

  test('6.5 统计随裁决自动更新且无待裁决冲突', async () => {
    const s = (await adminGet('/api/admin/stats')).body.data;
    assert.equal(s.open_conflicts, 0);
    assert.ok(s.accepted_records >= 4);
    assert.ok(s.canonical_points >= 3);
    assert.ok((s.records_by_status.rejected || 0) >= 2);
  });
});

describe('场景 7：管理员补传与未知点隔离', () => {
  test('7.1 管理员替设备补传走同一管线，冲突仍进队列', async () => {
    // 再改派 S02 给乙，然后管理员替甲补传 S02
    await adminPostTask('/api/admin/tasks/task-lake/reassign', {
      client_id: 'dev-b', reason: '测试：S02 改派乙',
    });
    const r1 = rec('task-lake', 'pt-lake-s02', { pH: 7.6, 浊度: 8.8, 总磷: 0.12 });
    const res = await adminPost('/api/admin/inbox/reupload', {
      device_token: TOKEN_A, client_id: 'dev-a', reason: '测试：管理员协助补传',
      batch: { batch_id: 'b-admin-' + uuid().slice(0, 6), client_id: 'dev-a', records: [r1] },
    });
    assert.equal(res.body.data.receipt.records[0].status, 'conflict');
    const auditRows = (await adminGet('/api/admin/audit')).body.data;
    assert.ok(auditRows.some((a) => a.action === 'admin-reupload'));
  });

  test('7.2 未知采样点记录被隔离而非丢弃或采纳', async () => {
    const r1 = rec('task-lake', 'pt-does-not-exist', { pH: 7.0 });
    const res = await upload(TOKEN_B, { batch_id: 'b-' + uuid().slice(0, 8), client_id: 'dev-b', records: [r1] });
    assert.equal(res.data.receipt.records[0].status, 'quarantined');
  });
});

describe('场景 8：网关代理与服务降级', () => {
  test('8.1 前端通过 Web 网关访问 API 正常', async () => {
    const r = await call('GET', `${WEB}/api/admin/stats`, undefined, ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
  test('8.2 内部接口不经过网关暴露', async () => {
    const r = await call('GET', `${WEB}/internal/health`);
    assert.equal(r.status, 404);
  });
});
