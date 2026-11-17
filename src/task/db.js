import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DATA_DIR } from '../shared/config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DATA_DIR + 'task.db');

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  client_id    TEXT PRIMARY KEY,          -- dev-a / dev-b
  name         TEXT NOT NULL,             -- 虚构设备名称
  token        TEXT NOT NULL UNIQUE,      -- 接入令牌（虚构）
  status       TEXT NOT NULL DEFAULT 'online', -- online | disconnected（网页可切断）
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id    TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,        -- 虚构任务编号
  title      TEXT NOT NULL,
  region     TEXT NOT NULL,              -- 虚构区域
  lock_mode  TEXT NOT NULL,              -- whole（整任务锁定） | points（细粒度领取）
  status     TEXT NOT NULL DEFAULT 'active', -- active | reassigned | closed
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_points (
  point_id   TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(task_id),
  code       TEXT NOT NULL,              -- 虚构采样点编号 S01...
  name       TEXT NOT NULL,              -- 虚构点位名称
  planned_parameter TEXT NOT NULL,       -- 计划测定参数
  UNIQUE(task_id, code)
);

-- 整任务归属：每次重分配追加一行（任务归属历史，不覆盖）
CREATE TABLE IF NOT EXISTS task_ownership (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  client_id     TEXT NOT NULL REFERENCES clients(client_id),
  granted_at    TEXT NOT NULL,
  revoked_at    TEXT,                    -- NULL = 当前生效归属
  reason        TEXT NOT NULL,
  superseded_by INTEGER                  -- 被哪条记录取代
);

-- 细粒度领取：lock_mode=points 时按采样点领取
CREATE TABLE IF NOT EXISTS point_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id    TEXT NOT NULL REFERENCES task_points(point_id),
  task_id     TEXT NOT NULL REFERENCES tasks(task_id),
  client_id   TEXT NOT NULL REFERENCES clients(client_id),
  claimed_at  TEXT NOT NULL,
  released_at TEXT,                      -- NULL = 当前生效
  reason      TEXT NOT NULL
);

-- 任务服务侧审计：归属、领取、切断、关闭等每一个决定
CREATE TABLE IF NOT EXISTS task_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,             -- admin / system / client:xxx
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,             -- task / point / client
  entity_id  TEXT NOT NULL,
  detail     TEXT NOT NULL              -- JSON
);
`);

export function audit(actor, action, entity, entityId, detail) {
  db.prepare(
    `INSERT INTO task_audit(at, actor, action, entity, entity_id, detail)
     VALUES(?,?,?,?,?,?)`
  ).run(new Date().toISOString(), actor, action, entity, entityId, JSON.stringify(detail ?? null));
}
