import { db, audit } from './db.js';
import { createServer, ok, fail, nowIso, uuid, sendJson } from '../shared/http.js';
import { PORTS, HOST } from '../shared/config.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-token-fictional';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'internal-key-fictional';

// ---------- 鉴权辅助 ----------

function authClient(req) {
  const token = req.headers['x-client-token'];
  if (!token) return { error: ['缺少 x-client-token', 401, 'NO_TOKEN'] };
  const c = db.prepare('SELECT * FROM clients WHERE token=?').get(token);
  if (!c) return { error: ['令牌无效', 401, 'BAD_TOKEN'] };
  return { client: c };
}

function authAdmin(req) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return { error: ['管理员令牌无效', 401, 'BAD_ADMIN_TOKEN'] };
  }
  return {};
}

function authInternal(req) {
  if (req.headers['x-internal-key'] !== INTERNAL_KEY) {
    return { error: ['内部调用密钥无效', 401, 'BAD_INTERNAL_KEY'] };
  }
  return {};
}

function guard(res, result) {
  if (result.error) {
    fail(res, result.error[1], result.error[2], result.error[0]);
    return true;
  }
  return false;
}

// ---------- 领域查询 ----------

function getTask(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId);
}

function activeOwner(taskId) {
  return db
    .prepare(
      `SELECT o.*, c.name AS client_name FROM task_ownership o
       JOIN clients c ON c.client_id=o.client_id
       WHERE o.task_id=? AND o.revoked_at IS NULL
       ORDER BY o.id DESC LIMIT 1`
    )
    .get(taskId);
}

function activeClaim(pointId) {
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name FROM point_claims p
       JOIN clients c ON c.client_id=c.client_id
       WHERE p.point_id=? AND p.released_at IS NULL
       ORDER BY p.id DESC LIMIT 1`
    )
    .get(pointId);
}

function listPoints(taskId) {
  return db
    .prepare(
      `SELECT tp.*,
              (SELECT pc.client_id FROM point_claims pc
                WHERE pc.point_id=tp.point_id AND pc.released_at IS NULL
                ORDER BY pc.id DESC LIMIT 1) AS claimed_by
       FROM task_points tp WHERE tp.task_id=? ORDER BY tp.code`
    )
    .all(taskId);
}

/** 核心归属判定：任务归属与"我能否写这个点"分开计算 */
function resolve(client, taskId, pointId) {
  const task = getTask(taskId);
  if (!task) return { task: null };
  const point = pointId
    ? db.prepare('SELECT * FROM task_points WHERE point_id=? AND task_id=?').get(pointId, taskId)
    : null;
  const owner = activeOwner(taskId);
  const claim = pointId ? activeClaim(pointId) : null;
  const online = client.status === 'online';

  let eligible = false;
  let reason = null;

  if (!online) reason = 'client_disconnected';
  else if (pointId && !point) reason = 'unknown_point'; // 任何模式下未知采样点都先隔离
  else if (task.lock_mode === 'whole' && !claim) {
    // 整任务锁定：没有点级改派记录时按任务归属判定
    if (!owner) reason = 'task_unassigned';
    else if (owner.client_id !== client.client_id) reason = 'task_locked_by_other';
    else eligible = true;
  } else {
    // 细粒度模式，或 whole 模式下发生过点级改派（以点领取为准）
    if (!claim) reason = 'point_unclaimed'; // 可自动领取
    else if (claim.client_id !== client.client_id) reason = 'point_claimed_by_other';
    else eligible = true;
  }

  return {
    task,
    point,
    online,
    lockMode: task.lock_mode,
    activeOwnerClientId: owner?.client_id || null,
    activeOwnerName: owner?.client_name || null,
    claimedByClientId: claim?.client_id || null,
    claimedByName: claim?.client_name || null,
    eligible,
    reason,
  };
}

/** 自动领取（接收入库服务在点无人持有时调用），带事务防并发双领 */
function autoClaim(client, taskId, pointId) {
  const r = resolve(client, taskId, pointId);
  if (!r.task) return { ok: false, status: 404, code: 'NO_TASK', reason: '任务不存在' };
  if (!r.online) return { ok: false, status: 409, code: 'CLIENT_DISCONNECTED', reason: r.reason, resolve: r };

  if (r.lockMode === 'whole') {
    if (r.eligible) return { ok: true, resolve: r };
    if (r.reason === 'task_unassigned') {
      const tx = db.prepare(
        `INSERT INTO task_ownership(task_id, client_id, granted_at, revoked_at, reason)
         VALUES(?,?,?,NULL,?)`
      );
      tx.run(taskId, client.client_id, nowIso(), '首次上传自动取得整任务锁定');
      audit(`client:${client.client_id}`, 'auto-lock-task', 'task', taskId, {
        client_id: client.client_id,
      });
      return { ok: true, resolve: resolve(client, taskId, pointId) };
    }
    return { ok: false, status: 409, code: r.reason.toUpperCase(), reason: r.reason, resolve: r };
  }

  // points 模式
  if (!r.point) return { ok: false, status: 404, code: 'UNKNOWN_POINT', reason: '采样点不存在' };
  if (r.eligible) return { ok: true, resolve: r };
  if (r.reason === 'point_unclaimed') {
    db.prepare(
      `INSERT INTO point_claims(point_id, task_id, client_id, claimed_at, released_at, reason)
       VALUES(?,?,?,?,NULL,?)`
    ).run(pointId, taskId, client.client_id, nowIso(), '首次上传自动领取采样点');
    audit(`client:${client.client_id}`, 'auto-claim-point', 'point', pointId, {
      task_id: taskId,
      client_id: client.client_id,
    });
    return { ok: true, resolve: resolve(client, taskId, pointId) };
  }
  return { ok: false, status: 409, code: r.reason.toUpperCase(), reason: r.reason, resolve: r };
}

// ---------- 路由 ----------

const routes = [
  // 设备自查
  {
    method: 'POST',
    pattern: '/api/devices/heartbeat',
    handler: async (req, res) => {
      const a = authClient(req);
      if (guard(res, a)) return;
      const c = a.client;
      if (c.status === 'disconnected') {
        // 被切断的设备心跳会被拒绝，前端据此显示"连接已被管理员切断"
        return fail(res, 403, 'DISCONNECTED', '该设备连接已被管理员切断');
      }
      db.prepare('UPDATE clients SET last_seen_at=? WHERE client_id=?').run(nowIso(), c.client_id);
      ok(res, { client_id: c.client_id, status: 'online', server_time: nowIso() });
    },
  },

  // 设备查看自己可见的任务与归属/领取状态
  {
    method: 'GET',
    pattern: '/api/my/tasks',
    handler: async (req, res) => {
      const a = authClient(req);
      if (guard(res, a)) return;
      const c = a.client;
      const tasks = db.prepare('SELECT * FROM tasks ORDER BY code').all();
      const data = tasks.map((t) => {
        const owner = activeOwner(t.task_id);
        const points = listPoints(t.task_id).map((p) => ({
          ...p,
          claimed_by_me: p.claimed_by === c.client_id,
        }));
        return {
          ...t,
          owner_client_id: owner?.client_id || null,
          owner_name: owner?.client_name || null,
          locked_by_me: owner?.client_id === c.client_id,
          points,
        };
      });
      ok(res, { client: { client_id: c.client_id, name: c.name, status: c.status }, tasks: data });
    },
  },

  // 手动领取：整任务锁定 或 单个采样点
  {
    method: 'POST',
    pattern: '/api/my/tasks/:taskId/claim',
    handler: async (req, res, params, body) => {
      const a = authClient(req);
      if (guard(res, a)) return;
      const result = autoClaim(a.client, params.taskId, body.point_id || null);
      if (!result.ok) return fail(res, result.status, result.code, result.reason, result.resolve || {});
      ok(res, result.resolve);
    },
  },

  // 归属/领取历史（设备端也可追溯）
  {
    method: 'GET',
    pattern: '/api/my/tasks/:taskId/history',
    handler: async (req, res, params) => {
      const a = authClient(req);
      if (guard(res, a)) return;
      const ownership = db
        .prepare('SELECT * FROM task_ownership WHERE task_id=? ORDER BY id')
        .all(params.taskId);
      const claims = db
        .prepare(
          `SELECT pc.* FROM point_claims pc JOIN task_points tp ON tp.point_id=pc.point_id
           WHERE tp.task_id=? ORDER BY pc.id`
        )
        .all(params.taskId);
      ok(res, { ownership, claims });
    },
  },

  // ---------- 管理员：设备 ----------
  {
    method: 'GET',
    pattern: '/api/admin/clients',
    handler: async (req, res) => {
      if (guard(res, authAdmin(req))) return;
      ok(res, db.prepare('SELECT client_id, name, status, last_seen_at, created_at FROM clients ORDER BY client_id').all());
    },
  },
  {
    method: 'POST',
    pattern: '/api/admin/clients/:clientId/disconnect',
    handler: async (req, res, params, body) => {
      if (guard(res, authAdmin(req))) return;
      const c = db.prepare('SELECT * FROM clients WHERE client_id=?').get(params.clientId);
      if (!c) return fail(res, 404, 'NO_CLIENT', '设备不存在');
      db.prepare("UPDATE clients SET status='disconnected' WHERE client_id=?").run(c.client_id);
      audit('admin', 'disconnect-client', 'client', c.client_id, { reason: body.reason || '管理员切断连接' });
      ok(res, { client_id: c.client_id, status: 'disconnected' });
    },
  },
  {
    method: 'POST',
    pattern: '/api/admin/clients/:clientId/reconnect',
    handler: async (req, res, params, body) => {
      if (guard(res, authAdmin(req))) return;
      const c = db.prepare('SELECT * FROM clients WHERE client_id=?').get(params.clientId);
      if (!c) return fail(res, 404, 'NO_CLIENT', '设备不存在');
      db.prepare("UPDATE clients SET status='online' WHERE client_id=?").run(c.client_id);
      audit('admin', 'reconnect-client', 'client', c.client_id, { reason: body.reason || '管理员恢复连接' });
      ok(res, { client_id: c.client_id, status: 'online' });
    },
  },

  // ---------- 管理员：任务与重新分配 ----------
  {
    method: 'GET',
    pattern: '/api/admin/tasks',
    handler: async (req, res) => {
      if (guard(res, authAdmin(req))) return;
      const tasks = db.prepare('SELECT * FROM tasks ORDER BY code').all();
      ok(res,
        tasks.map((t) => ({
          ...t,
          owner: activeOwner(t.task_id),
          points: listPoints(t.task_id),
        }))
      );
    },
  },
  {
    method: 'POST',
    pattern: '/api/admin/tasks/:taskId/reassign',
    handler: async (req, res, params, body) => {
      if (guard(res, authAdmin(req))) return;
      const task = getTask(params.taskId);
      if (!task) return fail(res, 404, 'NO_TASK', '任务不存在');
      const target = db.prepare('SELECT * FROM clients WHERE client_id=?').get(body.client_id);
      if (!target) return fail(res, 404, 'NO_CLIENT', '承接设备不存在');
      const reason = body.reason || '管理员重新分配';
      const pointIds = Array.isArray(body.point_ids) ? body.point_ids : null;

      db.exec('BEGIN');
      try {
        const now = nowIso();
        if (!pointIds) {
          // 整任务重分配：作废当前归属 + 释放全部点领取（历史保留），再授予新设备
          const owner = activeOwner(task.task_id);
          if (owner) {
            db.prepare('UPDATE task_ownership SET revoked_at=?, reason=? WHERE id=?')
              .run(now, reason, owner.id);
          }
          db.prepare(
            `UPDATE point_claims SET released_at=?, reason=?
             WHERE task_id=? AND released_at IS NULL`
          ).run(now, `随整任务重分配释放：${reason}`, task.task_id);
          const info = db.prepare(
            `INSERT INTO task_ownership(task_id, client_id, granted_at, revoked_at, reason, superseded_by)
             VALUES(?,?,?,NULL,?,?)`
          ).run(task.task_id, target.client_id, now, reason, owner?.id || null);
          db.prepare("UPDATE tasks SET status='reassigned' WHERE task_id=?").run(task.task_id);
          audit('admin', 'reassign-task', 'task', task.task_id, {
            from: owner?.client_id || null,
            to: target.client_id,
            reason,
            new_ownership_id: Number(info.lastInsertRowid),
          });
        } else {
          // 细粒度（含 whole 模式下的点级改派）：只重分配指定采样点
          for (const pid of pointIds) {
            const p = db.prepare('SELECT * FROM task_points WHERE point_id=? AND task_id=?')
              .get(pid, task.task_id);
            if (!p) throw Object.assign(new Error(`采样点不存在: ${pid}`), { status: 404 });
            const claim = activeClaim(pid);
            if (claim) {
              db.prepare('UPDATE point_claims SET released_at=?, reason=? WHERE id=?')
                .run(now, reason, claim.id);
            }
            db.prepare(
              `INSERT INTO point_claims(point_id, task_id, client_id, claimed_at, released_at, reason)
               VALUES(?,?,?,?,NULL,?)`
            ).run(pid, task.task_id, target.client_id, now, `管理员细粒度重分配：${reason}`);
            audit('admin', 'reassign-point', 'point', pid, {
              from: claim?.client_id || null,
              to: target.client_id,
              reason,
            });
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      ok(res, { task_id: task.task_id, owner: activeOwner(task.task_id), points: listPoints(task.task_id) });
    },
  },
  {
    method: 'POST',
    pattern: '/api/admin/tasks/:taskId/close',
    handler: async (req, res, params, body) => {
      if (guard(res, authAdmin(req))) return;
      const task = getTask(params.taskId);
      if (!task) return fail(res, 404, 'NO_TASK', '任务不存在');
      db.prepare("UPDATE tasks SET status='closed' WHERE task_id=?").run(task.task_id);
      audit('admin', 'close-task', 'task', task.task_id, { reason: body.reason || '管理员关闭任务' });
      ok(res, { task_id: task.task_id, status: 'closed' });
    },
  },
  {
    method: 'GET',
    pattern: '/api/admin/audit',
    handler: async (req, res, _p, _b, url) => {
      if (guard(res, authAdmin(req))) return;
      const entity = url.searchParams.get('entity');
      const entityId = url.searchParams.get('entity_id');
      const where = [];
      const args = [];
      if (entity) { where.push('entity=?'); args.push(entity); }
      if (entityId) { where.push('entity_id=?'); args.push(entityId); }
      const sql = 'SELECT * FROM task_audit' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT 300';
      ok(res, db.prepare(sql).all(...args));
    },
  },

  // ---------- 内部接口（仅接收入库服务调用） ----------
  {
    method: 'POST',
    pattern: '/internal/resolve',
    handler: async (req, res, _p, body) => {
      if (guard(res, authInternal(req))) return;
      const c = db.prepare('SELECT * FROM clients WHERE token=?').get(body.token);
      if (!c) return sendJson(res, 200, { valid_token: false });
      ok(res, { valid_token: true, client: { client_id: c.client_id, name: c.name, status: c.status },
                ownership: resolve(c, body.task_id, body.point_id || null) });
    },
  },
  {
    method: 'POST',
    pattern: '/internal/auto-claim',
    handler: async (req, res, _p, body) => {
      if (guard(res, authInternal(req))) return;
      const c = db.prepare('SELECT * FROM clients WHERE token=?').get(body.token);
      if (!c) return fail(res, 401, 'BAD_TOKEN', '令牌无效');
      const result = autoClaim(c, body.task_id, body.point_id || null);
      if (!result.ok) return fail(res, result.status, result.code, result.reason, result.resolve || {});
      ok(res, result.resolve);
    },
  },
  {
    method: 'GET',
    pattern: '/internal/health',
    handler: async (req, res) => {
      if (guard(res, authInternal(req))) return;
      ok(res, { service: 'task', time: nowIso() });
    },
  },
];

createServer(routes).listen(PORTS.TASK, HOST, () => {
  console.log(`[task] 任务服务监听 http://${HOST}:${PORTS.TASK}`);
});
