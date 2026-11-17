import { db, audit } from './db.js';
import { createServer, ok, fail, nowIso, uuid, call } from '../shared/http.js';
import { PORTS, HOST, TASK_URL } from '../shared/config.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-token-fictional';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'internal-key-fictional';

// ---------- 鉴权 ----------
function guard(res, result) {
  if (result.error) {
    fail(res, result.error[1], result.error[2], result.error[0]);
    return true;
  }
  return false;
}
function authAdmin(req) {
  return req.headers['x-admin-token'] === ADMIN_TOKEN
    ? {}
    : { error: ['管理员令牌无效', 401, 'BAD_ADMIN_TOKEN'] };
}

// ---------- 调用任务服务做归属判定（归属事实只存任务服务，入库服务不复制） ----------
async function resolveOwnership(token, taskId, pointId) {
  try {
    const r = await call(
      'POST',
      `${TASK_URL}/internal/resolve`,
      { token, task_id: taskId, point_id: pointId || null },
      { 'x-internal-key': INTERNAL_KEY }
    );
    if (r.status !== 200) throw new Error('任务服务返回异常');
    if (!r.body.data?.valid_token) return { badToken: true };
    return r.body.data;
  } catch (e) {
    return { unavailable: true, message: e.message };
  }
}

async function autoClaim(token, taskId, pointId) {
  try {
    const r = await call(
      'POST',
      `${TASK_URL}/internal/auto-claim`,
      { token, task_id: taskId, point_id: pointId || null },
      { 'x-internal-key': INTERNAL_KEY }
    );
    return { status: r.status, body: r.body };
  } catch (e) {
    return { status: 503, body: { error: { code: 'TASK_SERVICE_UNAVAILABLE', message: e.message } } };
  }
}

// ---------- 冲突辅助 ----------
function conflictKey(taskId, pointId) {
  return pointId ? `point:${pointId}` : `task:${taskId}`;
}

function getOpenConflict(key) {
  return db.prepare('SELECT * FROM conflicts WHERE conflict_key=? AND status=?').get(key, 'open');
}

function getLastConflict(key) {
  return db.prepare('SELECT * FROM conflicts WHERE conflict_key=? ORDER BY id DESC LIMIT 1').get(key);
}

function getCanonical(pointId) {
  if (!pointId) return null;
  return db
    .prepare('SELECT * FROM sample_records WHERE point_id=? AND canonical=1 LIMIT 1')
    .get(pointId);
}

function demoteCanonical(pointId, reason) {
  if (!pointId) return;
  db.prepare(
    `UPDATE sample_records SET canonical=0, superseded_at=?
     WHERE point_id=? AND canonical=1`
  ).run(nowIso(), pointId);
}

/**
 * 把一条无法直接采纳的记录送入可审阅冲突队列。
 * - 已存在 open 冲突：追加为 followup 候选（裁决中再次来数据，不覆盖不丢弃）
 * - 不存在：新建冲突；若该键此前裁决过，标记 followup_of（裁决后又来数据）
 */
function routeToConflict({ recordRow, key, reason, role, followupNote }) {
  let conflict = getOpenConflict(key);
  if (conflict) {
    db.prepare(
      `INSERT OR IGNORE INTO conflict_candidates(conflict_id, client_id, record_id, added_at, role)
       VALUES(?,?,?,?,?)`
    ).run(conflict.id, recordRow.client_id, recordRow.record_id, nowIso(), role);
    db.prepare('UPDATE sample_records SET status=?, conflict_id=?, note=? WHERE client_id=? AND record_id=?')
      .run('conflict', conflict.id, followupNote || null, recordRow.client_id, recordRow.record_id);
    audit('system', 'conflict-candidate-appended', 'conflict', conflict.id, {
      client_id: recordRow.client_id,
      record_id: recordRow.record_id,
      role,
    });
    return conflict.id;
  }

  const last = getLastConflict(key);
  const info = db.prepare(
    `INSERT INTO conflicts(task_id, point_id, conflict_key, reason, status, opened_at, followup_of)
     VALUES(?,?,?,?, 'open', ?, ?)`
  ).run(
    recordRow.task_id,
    recordRow.point_id || null,
    key,
    last ? 'post_resolution_new_data' : reason,
    nowIso(),
    last?.id || null
  );
  const conflictId = Number(info.lastInsertRowid);

  // 现任承接者的有效成果作为 incumbent 候选一并送审（如果存在）
  const canonical = getCanonical(recordRow.point_id);
  if (canonical) {
    db.prepare(
      `INSERT OR IGNORE INTO conflict_candidates(conflict_id, client_id, record_id, added_at, role)
       VALUES(?,?,?,?, 'incumbent')`
    ).run(conflictId, canonical.client_id, canonical.record_id, nowIso());
  }
  db.prepare(
    `INSERT INTO conflict_candidates(conflict_id, client_id, record_id, added_at, role)
     VALUES(?,?,?,?,?)`
  ).run(conflictId, recordRow.client_id, recordRow.record_id, nowIso(), role);
  db.prepare('UPDATE sample_records SET status=?, conflict_id=? WHERE client_id=? AND record_id=?')
    .run('conflict', conflictId, recordRow.client_id, recordRow.record_id);
  audit('system', 'conflict-opened', 'conflict', conflictId, {
    key,
    reason: last ? 'post_resolution_new_data' : reason,
    original_reason: reason,
    late_client: recordRow.client_id,
    incumbent: canonical ? `${canonical.client_id}/${canonical.record_id}` : null,
    followup_of: last?.id || null,
  });
  return conflictId;
}

// ---------- 上传管线 ----------
async function processBatch({ batch, token, actor, adminImpersonation = null }) {
  const clientId = adminImpersonation || batch.client_id;
  const now = nowIso();

  // 幂等①：批次级。回执丢失重传 → 回放冻结回执，不重复处理
  const existing = db.prepare('SELECT * FROM batches WHERE batch_id=?').get(batch.batch_id);
  if (existing) {
    db.prepare('UPDATE batches SET replay_count=replay_count+1, last_replay_at=? WHERE batch_id=?')
      .run(now, batch.batch_id);
    audit(actor, 'batch-replay', 'batch', batch.batch_id, { client_id: existing.client_id });
    const receipt = JSON.parse(existing.receipt);
    return { replay: true, receipt };
  }

  const recordResults = [];
  db.exec('BEGIN');
  try {
    for (let i = 0; i < batch.records.length; i++) {
      const rec = batch.records[i];
      const key = conflictKey(rec.task_id, rec.point_id || null);

      // 幂等②：记录级。同设备同 record_id 已存在 → 指向原处理结果，不产生第二条事实
      const dup = db
        .prepare('SELECT * FROM sample_records WHERE client_id=? AND record_id=?')
        .get(clientId, rec.record_id);
      if (dup) {
        recordResults.push({
          index: i,
          record_id: rec.record_id,
          status: 'duplicate',
          conflict_id: dup.conflict_id || null,
          canonical: !!dup.canonical,
          note: '重复提交，已关联到首次入库记录',
        });
        audit('system', 'record-duplicate', 'record', rec.record_id, {
          client_id: clientId,
          original_batch: dup.batch_id,
        });
        continue;
      }

      // 归属判定（任务服务是唯一事实源）
      const ownership = await resolveOwnership(token, rec.task_id, rec.point_id || null);
      if (ownership.unavailable) {
        throw Object.assign(new Error('任务服务暂不可用，整批拒收请稍后重试'), {
          status: 503,
          code: 'TASK_SERVICE_UNAVAILABLE',
        });
      }
      if (ownership.badToken) {
        throw Object.assign(new Error('设备令牌无效'), { status: 401, code: 'BAD_TOKEN' });
      }

      const o = ownership.ownership;

      // 先落一条事实记录（任何情况下真实采样都不丢），状态随后更新
      db.prepare(
        `INSERT INTO sample_records
           (record_id, client_id, task_id, point_id, sampled_at, payload, received_at, batch_id, status)
         VALUES(?,?,?,?,?,?,?,?,'conflict')`
      ).run(
        rec.record_id,
        clientId,
        rec.task_id,
        rec.point_id || null,
        rec.sampled_at,
        JSON.stringify(rec.payload || {}),
        now,
        batch.batch_id
      );
      const row = db
        .prepare('SELECT * FROM sample_records WHERE client_id=? AND record_id=?')
        .get(clientId, rec.record_id);

      // 未知任务/采样点：隔离，人工核查（不丢，但也不自动采纳）
      if (!o.task || o.reason === 'unknown_point') {
        db.prepare("UPDATE sample_records SET status='quarantined', note=? WHERE client_id=? AND record_id=?")
          .run('任务服务中不存在该任务或采样点', clientId, rec.record_id);
        audit('system', 'record-quarantined', 'record', rec.record_id, { client_id: clientId, reason: 'unknown_point' });
        recordResults.push({ index: i, record_id: rec.record_id, status: 'quarantined', note: '未知采样点，已隔离待审' });
        continue;
      }

      // 尝试自动取得写入资格（整任务锁定 / 细粒度领取；无人持有时可自动领取）
      const claim = await autoClaim(token, rec.task_id, rec.point_id || null);

      if (claim.status === 200) {
        // 获得资格：采纳为该点当前有效事实（canonical）。同点旧 canonical 降级但保留
        demoteCanonical(rec.point_id || null, '被同点位新采纳记录取代');
        db.prepare(
          `UPDATE sample_records SET status='accepted', accepted=1, canonical=1, note=NULL
           WHERE client_id=? AND record_id=?`
        ).run(clientId, rec.record_id);
        audit(actor, 'record-accepted', 'record', rec.record_id, {
          client_id: clientId,
          point_id: rec.point_id || null,
          admin_assisted: !!adminImpersonation,
        });
        recordResults.push({ index: i, record_id: rec.record_id, status: 'accepted', canonical: true });
        continue;
      }

      // 无资格：进入冲突队列（设备被切断 / 任务被他人锁定 / 点被他人领取）
      const reason = claim.body?.error?.code?.toLowerCase() || o.reason || 'ownership_conflict';
      const conflictId = routeToConflict({
        recordRow: row,
        key,
        reason,
        role: 'late',
        followupNote: getOpenConflict(key) ? '裁决过程中再次到达的数据，已追加为候选' : null,
      });
      recordResults.push({
        index: i,
        record_id: rec.record_id,
        status: 'conflict',
        conflict_id: conflictId,
        reason,
        note: '与当前任务归属冲突，已进入人工审阅队列',
      });
    }

    const receipt = {
      batch_id: batch.batch_id,
      client_id: clientId,
      received_at: now,
      replay: false,
      record_count: batch.records.length,
      records: recordResults,
    };
    db.prepare(
      `INSERT INTO batches(batch_id, client_id, received_at, record_count, receipt)
       VALUES(?,?,?,?,?)`
    ).run(batch.batch_id, clientId, now, batch.records.length, JSON.stringify(receipt));
    audit(actor, 'batch-received', 'batch', batch.batch_id, {
      client_id: clientId,
      records: batch.records.length,
      admin_assisted: !!adminImpersonation,
    });
    db.exec('COMMIT');
    return { replay: false, receipt };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 裁决 ----------
function conflictDetail(id) {
  const conflict = db.prepare('SELECT * FROM conflicts WHERE id=?').get(id);
  if (!conflict) return null;
  const candidates = db
    .prepare('SELECT * FROM conflict_candidates WHERE conflict_id=? ORDER BY id')
    .all(id);
  const records = candidates.map((c) => {
    const r = db
      .prepare('SELECT * FROM sample_records WHERE client_id=? AND record_id=?')
      .get(c.client_id, c.record_id);
    return r ? { ...r, candidate_role: c.role } : null;
  }).filter(Boolean);
  // 同点 canonical（可能不在候选表里，例如裁决后新建的版本）
  const canonical = getCanonical(conflict.point_id);
  if (canonical && !records.some((r) => r.client_id === canonical.client_id && r.record_id === canonical.record_id)) {
    records.push({ ...canonical, candidate_role: 'incumbent' });
  }
  const resolutions = db.prepare('SELECT * FROM resolutions WHERE conflict_id=? ORDER BY id').all(id);
  return { ...conflict, candidates, records, resolutions, canonical };
}

function resolveConflict({ conflictId, action, reason, decidedBy, winner, manual }) {
  const conflict = db.prepare('SELECT * FROM conflicts WHERE id=?').get(conflictId);
  if (!conflict) throw Object.assign(new Error('冲突不存在'), { status: 404, code: 'NO_CONFLICT' });
  if (conflict.status !== 'open') {
    throw Object.assign(new Error('该冲突已裁决，新数据会形成后继冲突，请在队列中处理'), {
      status: 409,
      code: 'ALREADY_RESOLVED',
    });
  }

  const before = conflictDetail(conflictId);
  const now = nowIso();
  const pointId = conflict.point_id || null;
  let winnerRecordId = null;
  let winnerClientId = null;

  db.exec('BEGIN');
  try {
    const candidateRecords = db
      .prepare(
        `SELECT sr.* FROM conflict_candidates cc
         JOIN sample_records sr ON sr.client_id=cc.client_id AND sr.record_id=cc.record_id
         WHERE cc.conflict_id=?`
      )
      .all(conflictId);

    if (action === 'accept_record') {
      if (!winner) throw Object.assign(new Error('accept_record 需要 winner_record_id'), { status: 400 });
      const w = candidateRecords.find((r) => r.record_id === winner.record_id && r.client_id === winner.client_id);
      if (!w) throw Object.assign(new Error('获胜记录不在候选列表中'), { status: 400, code: 'BAD_WINNER' });
      demoteCanonical(pointId, `冲突裁决 accept_record，被 ${w.client_id}/${w.record_id} 取代`);
      for (const r of candidateRecords) {
        const isWinner = r.client_id === w.client_id && r.record_id === w.record_id;
        db.prepare(
          `UPDATE sample_records SET accepted=?, canonical=?, status=?, superseded_at=?, conflict_id=NULL
           WHERE client_id=? AND record_id=?`
        ).run(isWinner ? 1 : 0, isWinner ? 1 : 0, isWinner ? 'accepted' : 'rejected', isWinner ? null : now, r.client_id, r.record_id);
      }
      winnerRecordId = w.record_id;
      winnerClientId = w.client_id;
    } else if (action === 'reject_all') {
      // 现任 canonical（如有）继续为准；迟到事实保留但标记 rejected，可追溯
      for (const r of candidateRecords) {
        if (r.canonical) continue;
        db.prepare(
          `UPDATE sample_records SET accepted=0, canonical=0, status='rejected', superseded_at=?, conflict_id=NULL
           WHERE client_id=? AND record_id=?`
        ).run(now, r.client_id, r.record_id);
      }
      const c = getCanonical(pointId);
      winnerRecordId = c?.record_id || null;
      winnerClientId = c?.client_id || null;
    } else if (action === 'merge_keep_canonical') {
      // 两不伤害：现任版本保持 canonical，迟到记录采纳为补充事实（accepted=1, canonical=0）
      const c = getCanonical(pointId);
      for (const r of candidateRecords) {
        const isCanonical = c && r.client_id === c.client_id && r.record_id === c.record_id;
        db.prepare(
          `UPDATE sample_records SET accepted=1, canonical=?, status='accepted', superseded_at=?, conflict_id=NULL
           WHERE client_id=? AND record_id=?`
        ).run(isCanonical ? 1 : 0, isCanonical ? null : now, r.client_id, r.record_id);
      }
      winnerRecordId = c?.record_id || null;
      winnerClientId = c?.client_id || null;
    } else if (action === 'manual_entry') {
      if (!manual || !manual.payload) throw Object.assign(new Error('manual_entry 需要 payload'), { status: 400 });
      demoteCanonical(pointId, '冲突裁决 manual_entry，人工版本取代');
      const manualId = `manual-${uuid().slice(0, 8)}`;
      db.prepare(
        `INSERT INTO sample_records
           (record_id, client_id, task_id, point_id, sampled_at, payload, received_at, batch_id, status, accepted, canonical, conflict_id)
         VALUES(?,?,?,?,?,?,?,?,'manual',1,1,NULL)`
      ).run(
        manualId,
        'admin',
        conflict.task_id,
        pointId,
        manual.sampled_at || now,
        JSON.stringify(manual.payload),
        now,
        `manual:${conflictId}`
      );
      db.prepare(
        `INSERT OR IGNORE INTO conflict_candidates(conflict_id, client_id, record_id, added_at, role)
         VALUES(?,?,?,?,'manual')`
      ).run(conflictId, 'admin', manualId, now);
      for (const r of candidateRecords) {
        db.prepare(
          `UPDATE sample_records SET accepted=0, canonical=0, status='rejected', superseded_at=?, conflict_id=NULL
           WHERE client_id=? AND record_id=?`
        ).run(now, r.client_id, r.record_id);
      }
      winnerRecordId = manualId;
      winnerClientId = 'admin';
    } else {
      throw Object.assign(new Error(`未知裁决动作: ${action}`), { status: 400, code: 'BAD_ACTION' });
    }

    db.prepare(
      `UPDATE conflicts SET status='resolved', resolved_at=?, decided_by=?, decision=?,
         winner_record_id=?, winner_client_id=? WHERE id=?`
    ).run(now, decidedBy, action, winnerRecordId, winnerClientId, conflictId);

    const after = conflictDetail(conflictId);
    db.prepare(
      `INSERT INTO resolutions(conflict_id, at, decided_by, action, reason, winner_record_id, before_snapshot, after_snapshot)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(conflictId, now, decidedBy, action, reason, winnerRecordId, JSON.stringify(before), JSON.stringify(after));
    audit(decidedBy, 'conflict-resolve', 'conflict', conflictId, {
      action,
      reason,
      winner: winnerClientId ? `${winnerClientId}/${winnerRecordId}` : null,
    });
    db.exec('COMMIT');
    return conflictDetail(conflictId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 统计（裁决后自动反映，无需手工维护） ----------
function stats(taskId) {
  const where = taskId ? 'WHERE task_id=?' : '';
  const args = taskId ? [taskId] : [];
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n,
              SUM(accepted) AS accepted_n, SUM(canonical) AS canonical_n
       FROM sample_records ${where} GROUP BY status`
    )
    .all(...args);
  const conflictRows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM conflicts ${where}
       GROUP BY status`
    )
    .all(...args);
  const pointsCovered = db
    .prepare(
      `SELECT COUNT(DISTINCT point_id) AS n FROM sample_records
       WHERE canonical=1 ${taskId ? 'AND task_id=?' : ''}`
    )
    .all(...(taskId ? [taskId] : []))[0].n;
  return {
    task_id: taskId || 'ALL',
    generated_at: nowIso(),
    records_by_status: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    accepted_records: counts.reduce((s, c) => s + (c.accepted_n || 0), 0),
    canonical_points: pointsCovered,
    conflicts: Object.fromEntries(conflictRows.map((c) => [c.status, c.n])),
    open_conflicts: conflictRows.find((c) => c.status === 'open')?.n || 0,
  };
}

// ---------- 路由 ----------
const routes = [
  // 设备上传（离线恢复后的补传也走这里）
  {
    method: 'POST',
    pattern: '/api/uploads',
    handler: async (req, res, _p, body) => {
      const token = req.headers['x-client-token'];
      if (!token) return fail(res, 401, 'NO_TOKEN', '缺少 x-client-token');
      if (!body.batch_id || !Array.isArray(body.records) || !body.records.length) {
        return fail(res, 400, 'BAD_BATCH', '需要 batch_id 与非空 records 数组');
      }
      const { replay, receipt } = await processBatch({
        batch: { ...body, client_id: body.client_id },
        token,
        actor: `client:${body.client_id || 'unknown'}`,
      });
      ok(res, { replay, receipt });
    },
  },
  // 设备查询回执（回执丢失时的显式查询通道）
  {
    method: 'GET',
    pattern: '/api/my/batch/:batchId',
    handler: async (req, res, params) => {
      const token = req.headers['x-client-token'];
      const ownership = await resolveOwnership(token, '__none__', null);
      if (ownership.badToken || !token) return fail(res, 401, 'BAD_TOKEN', '令牌无效');
      const b = db.prepare('SELECT * FROM batches WHERE batch_id=?').get(params.batchId);
      if (!b) return fail(res, 404, 'NO_BATCH', '批次不存在（服务器未收到，请重传）');
      ok(res, { replay_count: b.replay_count, receipt: JSON.parse(b.receipt) });
    },
  },
  // 设备查看自己事实记录的处理状态（知道数据在审阅而非被丢弃）
  {
    method: 'GET',
    pattern: '/api/my/records',
    handler: async (req, res, _p, _b, url) => {
      const token = req.headers['x-client-token'];
      const ownership = await resolveOwnership(token, '__none__', null);
      if (ownership.badToken || !token) return fail(res, 401, 'BAD_TOKEN', '令牌无效');
      const clientId = ownership.client?.client_id;
      const rows = db
        .prepare('SELECT record_id, task_id, point_id, status, accepted, canonical, conflict_id, note, received_at FROM sample_records WHERE client_id=? ORDER BY received_at DESC LIMIT 200')
        .all(clientId);
      ok(res, rows);
    },
  },

  // ---------- 管理员 ----------
  {
    method: 'GET',
    pattern: '/api/admin/conflicts',
    handler: async (req, res, _p, _b, url) => {
      if (guard(res, authAdmin(req))) return;
      const status = url.searchParams.get('status') || 'all';
      const where = status === 'all' ? '' : 'WHERE status=?';
      const args = status === 'all' ? [] : [status];
      const rows = db.prepare(`SELECT * FROM conflicts ${where} ORDER BY id DESC`).all(...args);
      ok(res, rows.map((c) => ({ ...c, candidate_count: db.prepare('SELECT COUNT(*) n FROM conflict_candidates WHERE conflict_id=?').get(c.id).n })));
    },
  },
  {
    method: 'GET',
    pattern: '/api/admin/conflicts/:id',
    handler: async (req, res, params) => {
      if (guard(res, authAdmin(req))) return;
      const d = conflictDetail(Number(params.id));
      if (!d) return fail(res, 404, 'NO_CONFLICT', '冲突不存在');
      ok(res, d);
    },
  },
  {
    method: 'POST',
    pattern: '/api/admin/conflicts/:id/resolve',
    handler: async (req, res, params, body) => {
      if (guard(res, authAdmin(req))) return;
      const d = await Promise.resolve(
        resolveConflict({
          conflictId: Number(params.id),
          action: body.action,
          reason: body.reason || '管理员裁决（未填写理由）',
          decidedBy: 'admin',
          winner: body.winner_record_id
            ? { record_id: body.winner_record_id, client_id: body.winner_client_id }
            : null,
          manual: body.manual || null,
        })
      );
      ok(res, d);
    },
  },
  {
    method: 'GET',
    pattern: '/api/admin/records',
    handler: async (req, res, _p, _b, url) => {
      if (guard(res, authAdmin(req))) return;
      const conds = [];
      const args = [];
      for (const k of ['task_id', 'point_id', 'status', 'client_id']) {
        const v = url.searchParams.get(k);
        if (v) { conds.push(`${k}=?`); args.push(v); }
      }
      const sql =
        'SELECT * FROM sample_records ' +
        (conds.length ? 'WHERE ' + conds.join(' AND ') : '') +
        ' ORDER BY received_at DESC LIMIT 300';
      ok(res, db.prepare(sql).all(...args));
    },
  },
  {
    method: 'GET',
    pattern: '/api/admin/stats',
    handler: async (req, res, _p, _b, url) => {
      if (guard(res, authAdmin(req))) return;
      ok(res, stats(url.searchParams.get('task_id')));
    },
  },
  {
    method: 'GET',
    pattern: '/api/admin/audit',
    handler: async (req, res) => {
      if (guard(res, authAdmin(req))) return;
      ok(res, db.prepare('SELECT * FROM ingest_audit ORDER BY id DESC LIMIT 300').all());
    },
  },
  // 管理员补传：替某台设备提交批次，走完全相同的管线（冲突仍进队列，绝不静默覆盖）
  {
    method: 'POST',
    pattern: '/api/admin/inbox/reupload',
    handler: async (req, res, _p, body) => {
      if (guard(res, authAdmin(req))) return;
      const targetToken = body.device_token;
      if (!targetToken || !body.batch) return fail(res, 400, 'BAD_REQUEST', '需要 device_token 与 batch');
      audit('admin', 'admin-reupload', 'batch', body.batch.batch_id, {
        reason: body.reason || '管理员协助补传',
      });
      const { replay, receipt } = await processBatch({
        batch: body.batch,
        token: targetToken,
        actor: 'admin',
        adminImpersonation: body.client_id || null,
      });
      ok(res, { replay, receipt });
    },
  },
  {
    method: 'GET',
    pattern: '/health',
    handler: async (_req, res) => ok(res, { service: 'ingest', time: nowIso() }),
  },
];

createServer(routes).listen(PORTS.INGEST, HOST, () => {
  console.log(`[ingest] 接收入库服务监听 http://${HOST}:${PORTS.INGEST}`);
});
