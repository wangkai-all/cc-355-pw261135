// 虚构种子数据：两台采样设备 + 两个任务（整任务锁定 / 细粒度领取）+ 采样点
// 所有名称、区域、参数均为虚构，不含任何个人真实信息。
import { db, audit } from '../src/task/db.js';
import { db as ingestDb } from '../src/ingest/db.js';
import { nowIso } from '../src/shared/http.js';

console.log('重置 ingest.db ...');
ingestDb.exec(`
  DELETE FROM resolutions;
  DELETE FROM conflict_candidates;
  DELETE FROM conflicts;
  DELETE FROM sample_records;
  DELETE FROM batches;
  DELETE FROM ingest_audit;
`);

console.log('重置 task.db ...');
db.exec(`
  DELETE FROM point_claims;
  DELETE FROM task_ownership;
  DELETE FROM task_points;
  DELETE FROM tasks;
  DELETE FROM clients;
  DELETE FROM task_audit;
`);

const now = nowIso();

const clients = [
  { client_id: 'dev-a', name: '采样终端-甲（虚构设备）', token: 'token-device-a' },
  { client_id: 'dev-b', name: '采样终端-乙（虚构设备）', token: 'token-device-b' },
];
for (const c of clients) {
  db.prepare(
    `INSERT INTO clients(client_id, name, token, status, last_seen_at, created_at)
     VALUES(?,?,?,'online',?,?)`
  ).run(c.client_id, c.name, c.token, now, now);
}

// 任务 1：整任务锁定模式
const t1 = db
  .prepare(
    `INSERT INTO tasks(task_id, code, title, region, lock_mode, status, created_at)
     VALUES('task-lake','T-2026-LAKE-01','虚构青螺湖湿地水质例行采样','虚构青螺湖湿地（演示区域）','whole','active',?)`
  )
  .run(now);
void t1;

const lakePoints = [
  ['S01', '青螺湖-入湖口', 'pH、浊度、溶解氧'],
  ['S02', '青螺湖-湖心', 'pH、浊度、总磷'],
  ['S03', '青螺湖-东岸浅滩', '溶解氧、氨氮、浊度'],
  ['S04', '青螺湖-出湖闸', 'pH、总磷、氨氮'],
];
for (const [code, name, param] of lakePoints) {
  db.prepare(
    `INSERT INTO task_points(point_id, task_id, code, name, planned_parameter)
     VALUES(?,?,?,?,?)`
  ).run(`pt-lake-${code.toLowerCase()}`, 'task-lake', code, name, param);
}
// 初始整任务归属给设备甲
db.prepare(
  `INSERT INTO task_ownership(task_id, client_id, granted_at, reason)
   VALUES('task-lake','dev-a',?, '任务初始化分配')`
).run(now);
audit('system', 'seed-ownership', 'task', 'task-lake', { client_id: 'dev-a' });

// 任务 2：细粒度领取模式
db.prepare(
  `INSERT INTO tasks(task_id, code, title, region, lock_mode, status, created_at)
   VALUES('task-forest','T-2026-FOREST-02','虚构云栖林场土壤背景值采样','虚构云栖林场（演示区域）','points','active',?)`
).run(now);

const forestPoints = [
  ['F01', '云栖-1号样地', '土壤pH、有机质'],
  ['F02', '云栖-2号样地', '土壤pH、含水率'],
  ['F03', '云栖-3号样地', '有机质、全氮'],
  ['F04', '云栖-4号样地', '含水率、全氮'],
  ['F05', '云栖-5号样地', '土壤pH、有机质、全氮'],
];
for (const [code, name, param] of forestPoints) {
  db.prepare(
    `INSERT INTO task_points(point_id, task_id, code, name, planned_parameter)
     VALUES(?,?,?,?,?)`
  ).run(`pt-forest-${code.toLowerCase()}`, 'task-forest', code, name, param);
}
// 细粒度模式：设备甲先领取前两个点
for (const pid of ['pt-forest-f01', 'pt-forest-f02']) {
  db.prepare(
    `INSERT INTO point_claims(point_id, task_id, client_id, claimed_at, reason)
     VALUES(?, 'task-forest','dev-a',?, '初始化领取')`
  ).run(pid, now);
}

console.log('种子数据完成：');
console.log('  设备:', clients.map((c) => `${c.client_id}(${c.token})`).join(', '));
console.log('  task-lake（整任务锁定）→ 当前归属 dev-a，4 个采样点');
console.log('  task-forest（细粒度领取）→ dev-a 领取 F01/F02，F03~F05 待领取，共 5 点');
