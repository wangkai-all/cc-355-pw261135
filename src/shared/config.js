// 全局配置：端口与地址。两个微服务独立进程、独立 SQLite 数据库。
export const PORTS = {
  WEB: Number(process.env.PORT_WEB || 4100),
  TASK: Number(process.env.PORT_TASK || 4101),
  INGEST: Number(process.env.PORT_INGEST || 4102),
};

export const HOST = '127.0.0.1';

export const TASK_URL = `http://${HOST}:${PORTS.TASK}`;
export const INGEST_URL = `http://${HOST}:${PORTS.INGEST}`;

// 数据目录（*.db 已在 .gitignore 中忽略）
export const DATA_DIR = new URL('../../data/', import.meta.url).pathname;
