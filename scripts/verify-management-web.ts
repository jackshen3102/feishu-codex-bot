import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type Database from "better-sqlite3";
import { createWebFixture } from "./web-fixture-data.js";
import { startWebServer } from "../src/web/server.js";
import { WebReadModel } from "../src/web/read-model.js";
import { loadWebConfig } from "../src/web/config.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oncall-web-verify-'));
const f = await createWebFixture(directory);
let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
function snapshot() {
  const schema = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all();
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return JSON.stringify({ version: f.db.pragma('user_version'), schema, rows: tables.map(t => [t.name, f.db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]) });
}
function ok(name: string) { console.log('PASS ' + name); }
try {
  const before = snapshot();
  server = await startWebServer({ config: { host: '127.0.0.1', port: 0 }, databasePath: f.databasePath, oncall: f.config, maxConcurrentTurns: 5 });
  const base = `http://localhost:${server.port}`;
  const get = async (route: string, workspace = 'infra') => {
    const u = new URL('/api/oncall/' + route, base); if (!u.searchParams.has('workspaceId')) u.searchParams.set('workspaceId', workspace);
    const r = await fetch(u); assert.equal(r.status, 200); return r.json() as Promise<any>;
  };
  const direct = async (route: string, status: number, headers: Record<string, string> = {}, method = 'GET') => {
    const r = await fetch(base + route, { method, headers }); assert.equal(r.status, status, route); return r;
  };
  const withHost = (route: string, status: number, headers: Record<string, string>) => new Promise<void>((resolve, reject) => {
    const request = http.get(base + route, { headers }, response => {
      try { assert.equal(response.statusCode, status, `${route} with Host ${headers.Host}`); } catch (error) { response.resume(); reject(error); return; }
      response.resume(); response.on('end', resolve);
    }); request.on('error', reject);
  });
  for (const route of ['/', '/app.js', '/styles.css', '/api/oncall/workspaces', '/api/oncall/overview?workspaceId=infra']) {
    const response = await direct(route, 200); assert.equal(response.headers.get('www-authenticate'), null); assert.equal(response.headers.get('set-cookie'), null);
  }
  ok('page, assets and APIs open directly without administrator authentication');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) { const response = await direct('/api/oncall/overview?workspaceId=infra', 405, {}, method); assert.equal(response.headers.get('access-control-allow-origin'), null); }
  await direct('/api/oncall/overview?workspaceId=infra', 403, { Origin: 'https://foreign.example' });
  const previewHost = `preview-12345678-1234-1234-1234-123456789abc.localhost:${server.port}`;
  await withHost('/', 200, { Host: previewHost });
  for (const route of ['/', '/app.js', '/styles.css', '/api/oncall/workspaces', '/api/oncall/overview?workspaceId=infra']) {
    await withHost(route, 200, { Host: previewHost, Origin: `http://${previewHost}` });
  }
  for (const host of ['foreign.example', `${previewHost}.foreign.example`, `preview.localhost:${server.port + 1}`, `user@preview.localhost:${server.port}`]) {
    await withHost('/', 403, { Host: host });
  }
  await withHost('/', 403, { Host: previewHost, Origin: base });
  await withHost('/', 403, { Host: previewHost, Origin: 'https://foreign.example' });
  await withHost('/', 403, { Host: previewHost, 'Sec-Fetch-Site': 'cross-site' });
  ok('iOS .localhost preview opens directly while retaining exact port and same-origin checks');
  const page = await direct('/?workspaceId=infra&topic=topic-snapshot&job=101', 200, { Accept: 'text/html' });
  assert(!(await page.text()).includes('管理员登录'));
  for (const route of ['/login', '/login.js', '/login.css', '/auth/login', '/auth/logout']) await direct(route, 404);
  for (const route of ['/auth/login', '/auth/logout']) await direct(route, 405, {}, 'POST');
  await direct('/api/oncall/workspaces', 200, { Cookie: 'oncall_session=obsolete' });
  ok('login UI and authentication endpoints removed; old cookies do not block access');
  for (const route of ['/web-password', '/bot.db', '/%2e%2e%2fweb-password', '/app.js/../web-password', '/api/oncall/topics?workspaceId=infra&limit=101', '/api/oncall/topics?workspaceId=infra&q=' + ('a'.repeat(201)), '/api/oncall/topics?workspaceId=infra&unknown=1']) await direct(route, route.includes('workspaceId') ? 400 : 404, {});
  ok('read-only methods, local origin and static allowlist');
  const workspaces = await (await fetch(base + '/api/oncall/workspaces', { headers: {} })).json() as any;
  assert.equal(workspaces.items.length, 3); assert(!JSON.stringify(workspaces).includes('not-for-browser')); assert(!JSON.stringify(workspaces).includes('ownerOpenId'));
  for (const route of ['/api/oncall/topics/topic-snapshot?workspaceId=other', '/api/oncall/topics/topic-snapshot/jobs/2000?workspaceId=infra', '/api/oncall/cases/topic-snapshot?workspaceId=other', '/api/oncall/topics/legacy?workspaceId=infra']) await direct(route, 404, {});
  await direct('/api/oncall/topics', 400, {}); await direct('/api/oncall/topics?workspaceId=unknown', 404, {}); ok('workspace and topic/job ownership');
  const states = await Promise.all([103, 970, 971, 972, 973].map((id, i) => get(`topics/${i ? 'topic-delivery-' + (i - 1) : 'topic-snapshot'}/jobs/${id}`)));
  assert.deepEqual(states.map(s => s.job.finalReply.state), ['abandoned', 'delivered', 'pending', 'delivering', null]); assert(states.every(s => s.job.executionStatus === 'succeeded')); assert.equal(states[0].job.finalReply.deliveredCount, 1); assert.equal(states[0].job.finalReply.totalCount, 2); ok('all reply fragments aggregate independently of execution');
  const stopped = await get('topics/topic-stopping'); assert(stopped.topic.paused); assert.equal(stopped.topic.currentJob.id, 201); assert.equal(stopped.topic.queuedCount, 1);
  const multiple = await get('topics/topic-multiple'); assert(multiple.topic.multipleActiveJobs); assert.equal(multiple.topic.currentJob.id, 951); assert.equal((await get('topics/topic-no-jobs')).topic.currentJob, null);
  const preparing=await get('topics/topic-active'); assert.equal(preparing.topic.currentJob.id,301); assert.equal(preparing.topic.multipleActiveJobs,false);
  ok('pause, stopping, queues, input preparation and inconsistent execution remain distinct');
  const old = await get('topics/topic-snapshot/jobs/101'), missing = await get('topics/topic-snapshot/jobs/102'); assert(old.caseSummary.summary.includes('旧轮次')); assert.equal(missing.caseSummary, null);
  const damaged = await get('topics/topic-damaged/jobs/601'); assert(damaged.dataWarnings.length >= 3); assert.equal(damaged.progress, null);
  const attachment = await get('topics/topic-attachment/jobs/801'); assert.equal(attachment.input.text, ''); assert(attachment.input.attachments.length >= 2); for (const secret of ['private-file-key', '/data/private.png', '/data/extra.log']) assert(!JSON.stringify(attachment).includes(secret));
  assert.equal((await get('topics/topic-missing-root/jobs/701')).input, null); assert.equal((await get('topics/topic-missing-root')).topic.title, '话题 topic-mi'); ok('round-specific history and corrupt/missing input degrade safely');
  for (const kind of ['topics', 'cases']) {
    let cursor: string | null = null; const ids: string[] = []; let firstCursor = '';
    do { const list = await get(`${kind}?limit=13${cursor ? '&cursor=' + cursor : ''}`); if (!firstCursor) firstCursor = list.nextCursor; ids.push(...list.items.map((v: any) => kind === 'topics' ? v.id : v.topicId)); cursor = list.nextCursor; } while (cursor);
    assert.equal(ids.length, new Set(ids).size); assert(ids.includes('infra-bulk-00')); assert(ids.includes('infra-bulk-34')); assert(ids.every(id => !id.startsWith('other-')));
    await direct(`/api/oncall/${kind}?workspaceId=other&cursor=${firstCursor}`, 400, {});
    const literal = await get(`${kind}?q=${encodeURIComponent('% _')}`); assert.equal(literal.items.length, 1);
  }
  const verified = await get('cases?verification=verified&limit=100'); assert(verified.items.length > 0); assert(verified.items.every((c: any) => c.conclusions.some((v: any) => v.verification === 'verified')));
  ok('keyset pagination, literal search and conclusion verification filter');
  await f.health(new Date(Date.now() - 100_000).toISOString()); assert.equal((await get('overview')).health.sampleStatus, 'stale'); await fs.writeFile(path.join(directory, 'health.json'), '{broken'); assert.equal((await get('overview')).health.sampleStatus, 'unavailable'); await f.health(); assert.equal((await get('overview')).health.sampleStatus, 'fresh'); ok('fresh, stale and unavailable health');
  const rowModel = new WebReadModel(f.databasePath, f.config);
  try { const connection = (rowModel as unknown as { db: Database.Database }).db; assert.throws(() => connection.prepare("UPDATE jobs SET execution_status='failed' WHERE id=301").run()); } finally { rowModel.close(); }
  assert.equal(snapshot(), before); ok('opening and all HTTP reads leave schema and business rows unchanged');
  // A reader must observe later WAL commits rather than an immutable snapshot.
  f.db.prepare("UPDATE jobs SET result_text='new WAL commit' WHERE id=701").run(); assert.equal((await get('topics/topic-missing-root/jobs/701')).resultText, 'new WAL commit'); ok('live WAL commits remain visible');
  assert.equal(loadWebConfig({}), null); assert.equal(loadWebConfig({ WEB_ENABLED: 'false' }), null); assert.deepEqual(loadWebConfig({ WEB_ENABLED: 'true' }), { host: '127.0.0.1', port: 6193 }); assert.throws(() => loadWebConfig({ WEB_ENABLED: 'true', WEB_PORT: 'invalid' })); ok('optional configuration defaults off');
  // Protocol exercise for HEAD and close, using a real listening socket.
  await new Promise<void>((resolve, reject) => { const req = http.request(base + '/', { method: 'HEAD', headers: {} }, res => { assert.equal(res.statusCode, 200); let size = 0; res.on('data', v => size += v.length); res.on('end', () => { assert.equal(size, 0); resolve(); }); }); req.on('error', reject); req.end(); });
  await server.close(); await server.close(); await assert.rejects(fetch(base)); ok('HEAD and idempotent bounded shutdown');
  console.log('Management Web integration verification passed');
} finally { await server?.close(); f.db.close(); await fs.rm(directory, { recursive: true, force: true }); }
