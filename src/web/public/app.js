import { initializeSession, currentSession, authorizedFetch, signIn, signOut, agentSettingsAvailable } from './session.js';
const app = document.querySelector('#app');
const overlay = document.querySelector('#overlay');
const executionLabels = { preparing: '准备中', queued: '排队中', running: '执行中', cancel_requested: '正在停止', succeeded: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' };
const deliveryLabels = { pending: '等待发送', delivering: '正在发送', delivered: '已发送', abandoned: '发送失败' };
const verificationLabels = { observed: '已观察', verified: '已验证', unverified: '未验证' };
const activeStatuses = ['running', 'preparing', 'cancel_requested'];
const state = { workspaces: [], workspace: null, overview: null, topics: null, cases: null, topic: null, jobs: null, detail: null, case: null, agentSettings: null, agentDraft: null, settingsMessage: '', savingSettings: false, error: '', loading: true };
let generation = 0;
let searchTimer;
let returnFocus;
let focusSearch = false;
let accountOpen = false;
let sessionReady = false;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = value => String(value ?? '').slice(0, 12);
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const params = () => new URLSearchParams(location.search);
const pageView = () => ['console', 'desk', 'cases', 'workspace'].includes(params().get('view')) ? params().get('view') : 'console';
const source = t => `${t.chatType === 'private' ? '私聊' : '群聊'} · ${short(t.chatId)}`;
function url(changes) {
  const p = new URLSearchParams({ view: pageView(), workspaceId: state.workspace?.id || '' });
  for (const [key, value] of Object.entries(changes)) if (value !== null && value !== undefined && value !== '') p.set(key, String(value));
  return '?' + p;
}
const navLink = (label, changes, classes = '') => `<a data-nav class="${classes}" href="${esc(url(changes))}">${label}</a>`;
const badge = (kind, label) => `<span class="badge ${esc(kind)}">${esc(label)}</span>`;
const execution = job => job ? badge(job.executionStatus, executionLabels[job.executionStatus] || '状态未知') : '<span class="muted">暂无执行</span>';
function delivery(job) {
  if (!job) return '<span class="muted">—</span>';
  const r = job.finalReply;
  return `${badge(r.state || 'none', r.state ? deliveryLabels[r.state] || '状态未知' : '暂无最终回复')}${r.state !== 'delivered' && r.deliveredCount > 0 ? `<small>已发送 ${r.deliveredCount}/${r.totalCount} 段</small>` : ''}`;
}
function facts(t) {
  const active = t.currentJob && activeStatuses.includes(t.currentJob.executionStatus);
  return `<dl class="facts"><div><dt>话题</dt><dd>${badge(t.paused ? 'paused' : 'none', t.paused ? '话题已暂停' : '话题未暂停')}${t.pauseReason ? `<small>${esc(t.pauseReason)}</small>` : ''}</dd></div><div><dt>${active ? '当前执行' : '最近一轮'}${t.currentJob ? ' · #' + t.currentJob.id : ''}</dt><dd>${execution(t.currentJob)}${t.multipleActiveJobs ? '<small class="warning">记录异常：存在多条活动任务</small>' : ''}</dd></div><div><dt>排队请求</dt><dd>${t.queuedCount} 条</dd></div><div><dt>${active ? '当前' : '最近'}轮次回复</dt><dd>${delivery(t.currentJob)}</dd></div></dl>`;
}
function conclusions(items = []) {
  return items.length ? `<div class="conclusions">${items.map(c => `<div class="conclusion"><p>${esc(c.text)}</p>${Object.hasOwn(verificationLabels, c.verification) ? badge(c.verification, verificationLabels[c.verification]) : ''}</div>`).join('')}</div>` : '';
}
function evidenceText(text) {
  return String(text).split(/(https?:\/\/[^\s<>"'，。；）]+)/g).map(part => {
    if (!/^https?:\/\//.test(part)) return esc(part);
    try { const u = new URL(part); if (!['https:', 'http:'].includes(u.protocol)) return esc(part); return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>`; } catch { return esc(part); }
  }).join('');
}
function evidence(items = []) {
  return items.length ? `<ul class="evidence">${items.map(e => `<li>${evidenceText(e)}</li>`).join('')}</ul>` : '<p class="empty small">暂无证据记录</p>';
}
function warnings(items = []) { return items.length ? `<div class="warning notice">${items.map(esc).join('；')}</div>` : ''; }
function pager(collection, id) { return collection?.nextCursor ? `<button class="button load-more" data-more="${id}">加载更多</button>` : ''; }
function navigation() {
  return `<nav aria-label="主导航">${[['console', '▦', '运行概览'], ['desk', '☷', '话题记录'], ['cases', '▤', '案例库'], ['workspace', '⚙', '工作区']].map(([v, i, label]) => navLink(`<span aria-hidden="true">${i}</span>${label}`, { view: v }, pageView() === v ? 'active' : '')).join('')}</nav>`;
}
function accountMenu() {
  const session = currentSession(), user = session.user;
  const initials = user ? esc(user.username.slice(0, 2).toUpperCase()) : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M5 21v-2a7 7 0 0 1 14 0v2"></path></svg>';
  return `<button class="account-trigger" data-account aria-label="账号菜单" aria-haspopup="menu" aria-expanded="${accountOpen}" title="${esc(user?.username || (session.enabled ? '未登录' : '本地访问'))}"><span class="user-avatar"><span>${initials}</span>${user?.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="用户头像" referrerpolicy="no-referrer">` : ''}</span></button>${accountOpen ? `<section class="account-menu" role="menu" aria-label="当前账号"><div class="account-identity"><b>${esc(user?.username || (session.enabled ? '未登录' : '本地访问'))}</b>${user ? `<p>${esc(user.email)}</p>` : '<p>当前页面未关联登录用户</p>'}</div>${session.enabled ? `<button role="menuitem" data-${user ? 'signout' : 'signin'}>${user ? '退出登录' : '飞书登录'}</button>` : ''}</section>` : ''}`;
}
function updateAccount() { const slot = document.querySelector('#account-slot'); if (slot) slot.innerHTML = accountMenu(); }
document.addEventListener('error', event => { if (event.target.matches?.('.user-avatar img')) event.target.hidden = true; }, true);
document.addEventListener('click', async event => {
  if (event.target.closest('[data-account]')) { accountOpen = !accountOpen; updateAccount(); if (accountOpen) document.querySelector('.account-menu [role=menuitem]')?.focus(); return; }
  if (event.target.closest('[data-signin]')) {
    try { await signIn(); sessionReady = true; accountOpen = false; await load(); }
    catch (error) { state.error = error.message; state.loading = false; render(); }
    return;
  }
  if (event.target.closest('[data-signout]')) {
    sessionReady = false; accountOpen = false; generation++; clearTimeout(searchTimer); state.error = ''; state.loading = false; state.savingSettings = false; state.settingsMessage = '';
    Object.assign(state, { workspaces: [], workspace: null, overview: null, topics: null, cases: null, topic: null, jobs: null, detail: null, case: null, agentSettings: null, agentDraft: null });
    try { await signOut(); render(); } catch { state.error = '暂时无法退出登录，请重试'; render(); }
    return;
  }
  if (accountOpen && !event.target.closest('.account-menu')) { accountOpen = false; updateAccount(); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && accountOpen) { accountOpen = false; updateAccount(); document.querySelector('[data-account]')?.focus(); }
});
function layout(content) {
  const w = state.workspace;
  return `<div class="shell"><aside class="sidebar">${navLink('<span class="brand-icon">∿</span>oncall <small>SPACE</small>', { view: 'console' }, 'brand')}<label class="workspace-choice"><span>业务工作区</span><select id="workspace-select" aria-label="业务工作区">${state.workspaces.map(item => `<option value="${esc(item.id)}" ${item.id === w?.id ? 'selected' : ''}>${esc(item.id)}</option>`).join('')}</select></label>${navigation()}<div class="sidebar-foot">${esc(w?.id || '')}</div></aside><main><header class="topbar"><div>工作空间 <span>/</span> ${{ console: '运行概览', desk: '话题记录', cases: '案例库', workspace: '工作区' }[pageView()] || '运行概览'}</div><div class="topbar-right"><span class="muted sampled-at">${state.overview ? '读取于 ' + date(state.overview.sampledAt) : ''}</span><div id="account-slot">${accountMenu()}</div></div></header><div class="error-bar" role="status" ${state.error ? '' : 'hidden'}>${state.error?'更新失败：'+esc(state.error):''} <button data-retry>重新读取</button></div>${state.loading && !state.overview && !state.topics ? '<p class="loading">正在读取…</p>' : content}</main></div>`;
}
function topicRows(items) {
  return items.map(t => navLink(`<div><b>${esc(t.title)}</b><small>${esc(short(t.id))} · 发起人 ${esc(short(t.ownerId))} · ${t.paused ? '话题已暂停' : '话题未暂停'} · 排队 ${t.queuedCount}</small></div><div class="row-status">${execution(t.currentJob)}${delivery(t.currentJob)}</div><span class="source">${esc(source(t))}</span>`, { view: 'desk', topic: t.id }, 'topic-row')).join('');
}
function filters(kind) {
  const current = params().get(kind === 'cases' ? 'verification' : 'filter') || 'all';
  const choices = kind === 'cases' ? [['all', '全部案例'], ['verified', '含已验证结论']] : [['all', '全部'], ['attention', '需关注'], ['running', '执行中'], ['succeeded', '本轮已完成']];
  return `<div class="filters">${choices.map(([id, label]) => `<button data-filter="${id}" data-kind="${kind}" class="${id === current ? 'active' : ''}" aria-pressed="${id === current}">${label}</button>`).join('')}<input class="search" id="search" aria-label="${kind === 'cases' ? '搜索案例' : '搜索话题'}" placeholder="${kind === 'cases' ? '搜索摘要或结论' : '搜索话题或编号'}" value="${esc(params().get('q') || '')}"></div>`;
}
function consolePage() {
  const m = state.overview?.metrics;
  const metrics = m ? [['执行占用', `${m.occupiedJobs} / ${m.maxConcurrentTurns}`, '包含正在停止的执行'], ['需关注话题', m.attentionTopics, '暂停、执行异常或发送失败'], ['排队请求', m.queuedJobs, '按请求计数'], ['回复发送失败', m.failedReplyJobs, '按执行轮次计数']] : [];
  const h = state.overview?.health;
  return `<div class="content"><div class="page-heading"><div><div class="eyebrow">OPERATIONS</div><h1>运行概览</h1><p>查看话题、执行轮次与回复发送情况。</p></div>${navLink('查看话题记录 →', { view: 'desk' }, 'button')}</div><section class="metrics" aria-label="任务概况">${metrics.map(([name, value, hint]) => `<div><span>${name}</span><strong>${value}</strong><small>${hint}</small></div>`).join('')}</section><div class="dashboard"><section class="panel"><div class="panel-heading"><h2>话题动态</h2><span>${m?.topicCount ?? '—'}</span></div>${filters('topics')}<div class="table-heading"><span>问题 / 话题</span><span>当前执行 / 回复</span><span class="source">来源</span></div>${state.topics?.items.length ? topicRows(state.topics.items) : '<p class="empty">没有匹配的话题</p>'}${pager(state.topics, 'topics')}</section><aside><section class="panel"><div class="panel-heading"><h2>服务快照</h2></div><div class="settings"><div><b>快照状态</b><span class="${h?.sampleStatus === 'fresh' ? '' : 'warning'}">${{ fresh: '有效', stale: '已过期', unavailable: '不可用' }[h?.sampleStatus] || '不可用'}</span></div>${h?.service ? `<div><b>进程状态</b><span>${{ running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止' }[h.service.state] || '未知'}</span></div><div><b>采样时间</b><span>${date(h.sampledAt)}</span></div>` : ''}</div></section><section class="panel"><div class="panel-heading"><h2>业务关联</h2></div><div class="settings"><div><b>群聊入口</b><span>${state.workspace?.bindings.filter(b => b.type === 'group').length || 0}</span></div><div><b>私聊入口</b><span>${state.workspace?.bindings.filter(b => b.type === 'private').length || 0}</span></div></div></section></aside></div></div>`;
}
function libraryPage() {
  const items = state.cases?.items || [];
  return `<div class="content library"><div class="eyebrow">COLLECTIVE KNOWLEDGE</div><h1>让每一次排查，<br>成为下一次的线索。</h1><p class="subtitle">结论与证据，保留来源轮次。</p>${filters('cases')}<div class="case-grid">${items.map(c => navLink(`<div class="muted case-meta">${esc(short(c.topicId))} · #${c.sourceJobId}</div><h2>${esc(c.summary.split('\n').find(v => v.trim())?.slice(0, 80) || '暂无摘要')}</h2><p>${esc(c.summary)}</p>${conclusions(c.conclusions)}${warnings(c.dataWarnings)}<footer><span>${date(c.updatedAt)}</span><span>${c.evidence.length} 条证据</span></footer>`, { view: 'cases', case: c.topicId }, 'case-card')).join('')}</div>${items.length ? '' : '<p class="empty">暂无匹配案例</p>'}${pager(state.cases, 'cases')}</div>`;
}
function jobRecord() {
  const d = state.detail;
  if (!d) return '<p class="empty">暂无执行轮次</p>';
  const j = d.job;
  const progress = [...(d.progress?.active || []), ...(d.progress?.recent || [])];
  return `<section class="record" aria-label="所选轮次"><div class="selected-round"><h2>#${j.id}</h2><span>执行 ${execution(j)}</span><span class="row-status">最终回复 ${delivery(j)}</span></div>${warnings(d.dataWarnings)}<div class="message"><span class="avatar" aria-hidden="true">人</span><div><div class="message-name">本轮请求 <time>${date(j.createdAt)}</time></div><div class="user-bubble">${d.input ? `<p>${esc(d.input.text || '仅附件消息')}</p>${d.input.attachments.map(a => `<small>${esc(a.type)} · ${esc(a.name)}</small>`).join('')}` : '<p class="muted">请求记录不可用</p>'}</div></div></div><div class="message"><span class="avatar bot">∿</span><div><div class="message-name">Oncall</div><article class="analysis"><h3>${d.resultText ? '本轮执行结果' : '本轮进展'}</h3>${d.resultText ? `<p class="result-text">${esc(d.resultText)}</p>` : progress.length ? `<ul class="progress">${progress.map(p => `<li>${esc(p.title)}${p.detail ? `<small>${esc(p.detail)}</small>` : ''}</li>`).join('')}</ul>` : `<p class="muted">${j.executionStatus === 'queued' ? '尚未开始执行' : '暂无结果或进展记录'}</p>`}${conclusions(d.caseSummary?.conclusions)}</article>${j.finalReply.state === 'abandoned' ? '<p class="warning">最终回复发送失败</p>' : ''}</div></div></section>`;
}
function deskPage() {
  const t = state.topic;
  return `<div class="desk-layout"><aside class="inbox"><h2>话题</h2>${state.topics?.items.map(item => navLink(`<div class="row-status">${execution(item.currentJob)}</div><b>${esc(item.title)}</b><small>${esc(short(item.id))} · ${item.paused ? '已暂停' : '未暂停'} · 排队 ${item.queuedCount}</small>`, { view: 'desk', topic: item.id }, 'inbox-item ' + (t?.id === item.id ? 'active' : ''))).join('') || '<p class="empty small">暂无话题</p>'}${pager(state.topics, 'topics')}</aside><div class="desk-main">${t ? `<header class="desk-heading"><div class="eyebrow">${esc(short(t.id))} / ${esc(source(t))}</div><h1>${esc(t.title)}</h1>${facts(t)}</header><div class="desk-body"><div class="conversation"><section class="rounds"><h2>执行轮次</h2><div class="round-list">${state.jobs?.items.map(j => navLink(`<b>#${j.id}</b>${execution(j)}<small>${date(j.createdAt)}</small>`, { view: 'desk', topic: t.id, job: j.id }, 'round-item ' + (state.detail?.job.id === j.id ? 'active' : ''))).join('') || '<p class="empty small">暂无轮次</p>'}</div>${pager(state.jobs, 'jobs')}</section>${jobRecord()}</div><aside class="evidence-panel"><h2>本轮证据记录</h2>${evidence(state.detail?.caseSummary?.evidence)}${state.detail?.caseSummary ? `<section class="source-case"><h2>本轮案例</h2><p>${esc(state.detail.caseSummary.summary)}</p></section>` : ''}<section class="source-case"><h2>来源</h2><p>${esc(source(t))}<br>${esc(t.id)}${state.detail ? ' · #' + state.detail.job.id : ''}</p></section></aside></div>` : '<p class="empty">暂无话题记录</p>'}</div></div>`;
}
function agentSettingsForm() {
  const settings = state.agentDraft || state.agentSettings;
  return `<section class="panel"><div class="panel-heading"><h2>模型设置</h2><span>全局 · 仅管理员</span></div>${settings ? `<form id="agent-settings-form" class="agent-settings"><label>执行引擎<select id="agent-backend" name="backend" ${state.savingSettings ? 'disabled' : ''}><option value="codex" ${settings.backend === 'codex' ? 'selected' : ''}>Codex</option><option value="traex" ${settings.backend === 'traex' ? 'selected' : ''}>traex</option></select></label><label>模型 ID<input id="agent-model" name="model" ${state.savingSettings ? 'disabled' : ''} maxlength="128" value="${esc(settings.model || '')}" placeholder="留空使用所选引擎的默认模型" autocomplete="off"></label><p class="muted">适用于所有工作区的下一轮执行。正在执行的任务保持原选择；首次切换引擎会建立独立会话。</p><button class="button primary" type="submit" ${state.savingSettings ? 'disabled' : ''}>${state.savingSettings ? '正在保存…' : '保存模型设置'}</button><p role="status">${esc(state.settingsMessage)}</p></form>` : '<p class="empty small">模型设置暂不可用</p>'}</section>`;
}
function workspacePage() {
  const w = state.workspace;
  if (!w) return '';
  const rows = (items, empty) => items.length ? items.map(([title, detail]) => `<div><b>${esc(title)}</b><span>${esc(detail)}</span></div>`).join('') : `<p class="empty small">${empty}</p>`;
  return `<div class="content"><div class="eyebrow">WORKSPACE</div><h1>业务工作区</h1><p class="subtitle">${esc(w.id)}</p><div class="workspace-grid">${agentSettingsAvailable() ? agentSettingsForm() : ''}<section class="panel"><div class="panel-heading"><h2>会话绑定</h2></div><div class="settings">${rows(w.bindings.map(b => [b.type === 'private' ? '私聊' : '群聊', b.chatId]), '暂无绑定')}</div></section><section class="panel"><div class="panel-heading"><h2>关联仓库</h2></div><div class="settings">${rows(w.repositories.map(r => [r.name, [r.description, r.url, r.defaultRef].filter(Boolean).join(' · ')]), '暂无关联仓库')}</div></section><section class="panel"><div class="panel-heading"><h2>知识资料</h2></div><div class="settings">${rows(w.knowledgePaths.map(p => [p, '资料路径']), '暂无知识资料')}</div></section><section class="panel"><div class="panel-heading"><h2>执行配置</h2></div><div class="settings">${rows([['最大并行执行数', state.maxConcurrentTurns], ['同话题请求', '按顺序执行'], ['中断恢复', '明确继续后核对现场']], '')}</div></section></div></div>`;
}
function render() {
  const v = pageView(); document.title = `Oncall · ${{ console: '运行概览', desk: '话题记录', cases: '案例库', workspace: '工作区' }[v] || '运行概览'}`;
  app.innerHTML = layout(v === 'desk' ? deskPage() : v === 'cases' ? libraryPage() : v === 'workspace' ? workspacePage() : consolePage());
  renderCase();
  if (focusSearch && !state.loading) { const search = document.querySelector('#search'); search?.focus(); search?.setSelectionRange(search.value.length, search.value.length); focusSearch = false; }
}
function renderCase() {
  const c = state.case;
  if (!c || !params().get('case')) { overlay.innerHTML = ''; document.body.style.overflow = ''; return; }
  overlay.innerHTML = `<div class="backdrop" data-dismiss><section class="drawer" role="dialog" aria-modal="true" aria-label="案例详情"><header><span>${esc(short(c.topicId))}</span><button class="close" data-dismiss aria-label="关闭详情">×</button></header><h1>${esc(c.summary.split('\n')[0]?.slice(0, 80) || '案例')}</h1>${warnings(c.dataWarnings)}<h2>案例摘要</h2><p>${esc(c.summary)}</p><h2>结论与验证</h2>${conclusions(c.conclusions)}<h2>证据记录</h2>${evidence(c.evidence)}<h2>来源轮次</h2><p>${esc(c.topicId)} · #${c.sourceJobId}</p>${navLink('查看来源轮次 →', { view: 'desk', topic: c.topicId, job: c.sourceJobId }, 'button primary')}</section></div>`;
  document.body.style.overflow = 'hidden'; overlay.querySelector('button')?.focus();
}
async function api(route, query = {}) {
  const p = new URLSearchParams(query);
  const response = await authorizedFetch('/api/oncall/' + route + (p.size ? '?' + p : ''), { credentials: 'same-origin', cache: 'no-store' });
  let result; try { result = await response.json(); } catch { throw new Error('页面数据无法读取，请稍后重试'); }
  if (!response.ok) throw new Error(result.error?.message || '读取失败'); return result;
}
function listArgs(kind, cursor) {
  const p = params(); return { workspaceId: state.workspace.id, limit: '30', ...(kind !== 'jobs' ? { q: p.get('q') || '', [kind === 'cases' ? 'verification' : 'filter']: p.get(kind === 'cases' ? 'verification' : 'filter') || 'all' } : {}), ...(cursor ? { cursor } : {}) };
}
async function collection(kind, poll, topicId) {
  const route = kind === 'jobs' ? 'topics/' + encodeURIComponent(topicId || params().get('topic') || state.topic?.id || '') + '/jobs' : kind;
  const prior = state[kind];
  const result = await api(route, listArgs(kind));
  const target = poll ? prior?.items.length || 30 : 30;
  while (result.nextCursor && result.items.length < target) {
    const next = await api(route, { ...listArgs(kind, result.nextCursor), limit: String(Math.min(100, target - result.items.length)) });
    result.items.push(...next.items); result.nextCursor = next.nextCursor;
  }
  return result;
}
async function load({ poll = false } = {}) {
  const id = ++generation;
  state.error = ''; state.loading = !poll;
  try {
    if (!state.workspaces.length) { const data = await api('workspaces'); if (id !== generation) return; state.workspaces = data.items; state.maxConcurrentTurns = data.maxConcurrentTurns; }
    const p = params(); const workspaceId = p.get('workspaceId') || state.workspaces[0]?.id;
    const w = state.workspaces.find(w => w.id === workspaceId); if (!w) throw new Error('工作区不存在');
    state.workspace = w;
    if (!p.has('workspaceId')) { p.set('workspaceId', w.id); history.replaceState(null, '', '?' + p); }
    const v = pageView(); const patch = {};
    if (v === 'workspace' && agentSettingsAvailable()) patch.agentSettings = await api('agent-settings');
    if (v === 'console') {
      const [overview, topics] = await Promise.all([api('overview', { workspaceId: w.id }), collection('topics', poll)]);
      patch.overview = overview; patch.topics = topics;
    } else if (v === 'cases') {
      patch.cases = await collection('cases', poll);
      patch.case = p.get('case') ? await api('cases/' + encodeURIComponent(p.get('case')), { workspaceId: w.id }) : null;
    } else if (v === 'desk') {
      const topics = await collection('topics', poll); patch.topics = topics;
      const topicId = p.get('topic') || topics.items[0]?.id;
      if (topicId) {
        const route = 'topics/' + encodeURIComponent(topicId);
        const [{ topic }, jobs] = await Promise.all([api(route, { workspaceId: w.id }), collection('jobs', poll, topicId)]);
        patch.topic = topic; patch.jobs = jobs;
        const jobId = p.get('job') || topic.currentJob?.id;
        const historical = state.detail && state.detail.job.id === Number(jobId) && topic.currentJob?.id !== Number(jobId) && !activeStatuses.includes(state.detail.job.executionStatus);
        patch.detail = jobId ? (poll && historical ? state.detail : await api(route + '/jobs/' + encodeURIComponent(jobId), { workspaceId: w.id })) : null;
      } else { patch.topic = null; patch.jobs = null; patch.detail = null; }
    }
    if (id !== generation) return;
    Object.assign(state, patch); state.loading = false; render();
  } catch (error) { if (id !== generation) return; const session = currentSession(); if (session.enabled && (!session.user || !session.canManage)) { sessionReady = false; Object.assign(state, { workspaces: [], workspace: null, overview: null, topics: null, cases: null, topic: null, jobs: null, detail: null, case: null, agentSettings: null, agentDraft: null }); } state.error = error.message; state.loading = false; render(); }
}
function navigate(changes, { replace = false } = {}) {
  generation++;
  clearTimeout(searchTimer);
  focusSearch = document.activeElement?.id === 'search';
  const next = url(changes); history[replace ? 'replaceState' : 'pushState'](null, '', next);
  Object.assign(state, { overview: null, topics: null, cases: null, topic: null, jobs: null, detail: null, case: null, loading: true, error: '' });
  render(); void load();
}
async function loadMore(kind, button) {
  const collection = state[kind]; if (!collection?.nextCursor) return;
  const id = generation; button.disabled = true;
  try {
    const route = kind === 'jobs' ? 'topics/' + encodeURIComponent(state.topic.id) + '/jobs' : kind;
    const fresh = await api(route, listArgs(kind, collection.nextCursor)); if (id !== generation) return;
    const key = kind === 'cases' ? 'topicId' : 'id'; const ids = new Set(collection.items.map(item => item[key]));
    state[kind] = { items: [...collection.items, ...fresh.items.filter(item => !ids.has(item[key]))], nextCursor: fresh.nextCursor }; render();
  } catch (error) { if (id === generation) { state.error = error.message; render(); } }
}
document.addEventListener('submit', async event => {
  if (event.target.id !== 'agent-settings-form') return;
  event.preventDefault();
  if (state.savingSettings) return;
  const form = new window.FormData(event.target);
  const settings = { backend: form.get('backend'), model: String(form.get('model') || '').trim() || null };
  const id = generation;
  state.savingSettings = true; state.settingsMessage = ''; render();
  try {
    const response = await authorizedFetch('/api/oncall/agent-settings', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    const result = await response.json();
    if (id !== generation) return;
    if (!response.ok) throw new Error(result.error?.message || '保存失败');
    state.agentSettings = result; state.agentDraft = null; state.settingsMessage = '已保存，从下一轮执行生效。';
  } catch (error) { if (id === generation) state.settingsMessage = error.message; }
  finally { state.savingSettings = false; render(); }
});
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-nav]');
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); const target = new URL(link.href); returnFocus = document.activeElement; const changes = Object.fromEntries(target.searchParams); navigate(changes); return; }
  const button = event.target.closest('button');
  if (button?.hasAttribute('data-dismiss') || event.target.hasAttribute('data-dismiss')) { const p = Object.fromEntries(params()); delete p.case; navigate(p, { replace: true }); returnFocus?.focus(); return; }
  if (button?.hasAttribute('data-filter')) { const p = Object.fromEntries(params()); delete p.case; p[button.dataset.kind === 'cases' ? 'verification' : 'filter'] = button.dataset.filter; navigate(p); }
  if (button?.hasAttribute('data-retry')) void start();
  if (button?.dataset.more) void loadMore(button.dataset.more, button);
});
function captureAgentDraft() {
  state.agentDraft = { backend: document.querySelector('#agent-backend').value, model: document.querySelector('#agent-model').value };
  state.settingsMessage = '';
  document.querySelector('#agent-settings-form [role=status]').textContent = '';
}
document.addEventListener('change', event => {
  if (event.target.id === 'workspace-select') navigate({ view: pageView(), workspaceId: event.target.value });
  if (['agent-backend', 'agent-model'].includes(event.target.id)) captureAgentDraft();
});
document.addEventListener('input', event => {
  if (event.target.id === 'agent-model') captureAgentDraft();
  if (event.target.id !== 'search') return; const value = event.target.value;
  clearTimeout(searchTimer); searchTimer = setTimeout(() => {
    const p = Object.fromEntries(params()); p.q = value; navigate(p, { replace: true });
  }, 350);
});
document.addEventListener('keydown', event => {
  if (!overlay.firstElementChild) return;
  if (event.key === 'Escape') { const p = Object.fromEntries(params()); delete p.case; navigate(p, { replace: true }); }
  if (event.key === 'Tab') { const items = [...overlay.querySelectorAll('button,a[href]')]; const first = items[0], last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
});
window.addEventListener('popstate', () => { clearTimeout(searchTimer); Object.assign(state, { overview: null, topics: null, cases: null, topic: null, jobs: null, detail: null, case: null }); void load(); });
setInterval(() => { if (sessionReady && !document.hidden && !state.loading && !params().get('case') && !state.savingSettings && !['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) void load({ poll: true }); }, 10_000);
async function start() {
  render();
  try { await initializeSession(); sessionReady = true; await load(); }
  catch (error) { state.error = error.message; state.loading = false; render(); }
}
void start();
