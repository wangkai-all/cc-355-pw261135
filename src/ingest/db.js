import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DATA_DIR } from '../shared/config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DATA_DIR + 'ingest.db');

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
-- 上传批次：处理结果持久化，回执丢失时重传返回同一份回执（幂等核心）
CREATE TABLE IF NOT EXISTS batches (
  batch_id       TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  record_count   INTEGER NOT NULL,
  replay_count   INTEGER NOT NULL DEFAULT 0,
  last_replay_at TEXT,
  receipt        TEXT NOT NULL             -- 首次处理后冻结的完整回执 JSON
);

-- 事实记录表：谁采的样永远保留，与"当前归属/是否采纳"分离
CREATE TABLE IF NOT EXISTS sample_records (
  record_id     TEXT NOT NULL,             -- 设备端生成的稳定 ID
  client_id     TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  point_id      TEXT,
  sampled_at    TEXT NOT NULL,
  payload       TEXT NOT NULL,             -- 虚构采样数据 JSON
  received_at   TEXT NOT NULL,
  batch_id      TEXT NOT NULL,
  -- 生命周期状态：accepted | conflict | quarantined | duplicate | manual
  status        TEXT NOT NULL,
  accepted      INTEGER NOT NULL DEFAULT 0,-- 是否作为有效事实
  canonical     INTEGER NOT NULL DEFAULT 0,-- 是否为该点当前采纳版本（每点至多一条=1）
  conflict_id   INTEGER,
  superseded_at TEXT,                      -- 被裁决取代的时间
  note          TEXT,
  PRIMARY KEY (client_id, record_id)       -- 同设备同记录 ID 天然去重
);
CREATE INDEX IF NOT EXISTS idx_rec_point ON sample_records(task_id, point_id);
CREATE INDEX IF NOT EXISTS idx_rec_conflict ON sample_records(conflict_id);

-- 冲突队列
CREATE TABLE IF NOT EXISTS conflicts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  point_id      TEXT,                     -- whole 模式按任务聚合时可为空
  conflict_key  TEXT NOT NULL,            -- task:<id> 或 point:<id>
  reason        TEXT NOT NULL,            -- point_claimed_by_other / task_locked_by_other / client_disconnected / post_resolution_new_data ...
  status        TEXT NOT NULL DEFAULT 'open', -- open | resolved
  opened_at     TEXT NOT NULL,
  resolved_at   TEXT,
  decided_by    TEXT,
  decision      TEXT,                     -- accept_record | reject_all | merge_keep_canonical | manual_entry
  winner_record_id TEXT,
  winner_client_id TEXT,
  followup_of   INTEGER                   -- 裁决后又来数据时，指向原冲突
);
-- 同一冲突键同时只允许一个 open；resolved 记录不受限制（SQLite 部分索引）
CREATE UNIQUE INDEX IF NOT EXISTS idx_conflicts_one_open
  ON conflicts(conflict_key) WHERE status='open';

-- 冲突候选：裁决期间再次来的数据全部追加为候选，不覆盖、不丢弃
CREATE TABLE IF NOT EXISTS conflict_candidates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_id INTEGER NOT NULL REFERENCES conflicts(id),
  client_id   TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  role        TEXT NOT NULL,              -- incumbent（现任成果） | late（旧端迟到数据） | followup | manual
  UNIQUE(conflict_id, client_id, record_id)
);

-- 裁决历史：每个决定可追溯（决定前后状态快照 + 理由）
CREATE TABLE IF NOT EXISTS resolutions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_id   INTEGER NOT NULL,
  at            TEXT NOT NULL,
  decided_by    TEXT NOT NULL,
  action        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  winner_record_id TEXT,
  before_snapshot TEXT NOT NULL,
  after_snapshot  TEXT NOT NULL
);

-- 接收入库侧审计
CREATE TABLE IF NOT EXISTS ingest_audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail    TEXT NOT NULL
);
`);

export function audit(actor, action, entity, entityId, detail) {
  db.prepare(
    `INSERT INTO ingest_audit(at, actor, action, entity, entity_id, detail)
     VALUES(?,?,?,?,?,?)`
  ).run(new Date().toISOString(), actor, action, entity, String(entityId), JSON.stringify(detail ?? null));
}
