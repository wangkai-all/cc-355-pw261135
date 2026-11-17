// 同时拉起三个服务进程，统一输出前缀与退出处理
import { spawn } from 'node:child_process';

const procs = [
  { name: 'task', file: 'src/task/server.js', color: '36' },
  { name: 'ingest', file: 'src/ingest/server.js', color: '35' },
  { name: 'web', file: 'src/web/server.js', color: '32' },
];

const children = procs.map((p) => {
  const child = spawn(process.execPath, [p.file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m`;
  child.stdout.on('data', (d) =>
    d.toString().split('\n').filter(Boolean).forEach((l) => console.log(tag, l))
  );
  child.stderr.on('data', (d) =>
    d.toString().split('\n').filter(Boolean).forEach((l) => console.error(tag, l))
  );
  return child;
});

const shutdown = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
