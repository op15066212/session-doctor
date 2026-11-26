#!/usr/bin/env node
// 判据：会话医生只扫 pi 会话，不扫子代理运行记录。
// 服务的真实事故（2026-11-26）：subagent-artifacts/*_transcript.jsonl 被当成会话扫进来，
// 报出「思考签名」，执行时 applyClean 按 id 找不到目标（cleaned=0），删除那一步却按下标删了它 ——
// 结构判据因此变红、拒绝写盘；界面显示「清签名条数 32 → 0，清 0」，人看不懂为什么。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = join(tmpdir(), 'session-doctor-scope');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'proj-a', 'subagent-artifacts'), { recursive: true });

// 一份真会话（有 id / parentId / type）
writeFileSync(join(DIR, 'proj-a', 's1.jsonl'), JSON.stringify({ type: 'message', id: 'a1', parentId: null, timestamp: '2026-11-26T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '真的会话' }] } }) + '\n');
// 一份子代理记录（无 id、无 type、字段是 recordType/role/text）
writeFileSync(join(DIR, 'proj-a', 'subagent-artifacts', 'x_transcript.jsonl'), JSON.stringify({ version: 1, recordType: 'message', role: 'assistant', text: '子代理输出', timestamp: '2026-11-26T00:00:01.000Z' }) + '\n');

process.env.SESSION_DOCTOR_DIR = DIR;
process.env.SESSION_DOCTOR_BACKUP = join(DIR, '..', 'session-doctor-scope-backup');
const { startServer } = await import('./session-doctor.mjs');
const server = await startServer({ port: 7795 });
let fail = 0;
const ok = (name, cond, detail) => { console.log((cond ? 'OK   ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); if (!cond) fail += 1; };
try {
  const res = await fetch('http://127.0.0.1:' + server.port + '/api/scan');
  const data = await res.json();
  const names = data.map((f) => f.name);
  ok('扫到真会话', names.some((n) => n === 's1.jsonl'), names.join(',') || '空');
  ok('不扫子代理记录', !names.some((n) => n.includes('transcript')), names.join(',') || '空');
  ok('文件数 = 1', data.length === 1, String(data.length));
} finally {
  if (!server.reused) await server.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(fail === 0 ? 'RESULT=PASS' : 'RESULT=FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);