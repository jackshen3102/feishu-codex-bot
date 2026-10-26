const app = document.querySelector('#app');
const overlay = document.querySelector('#overlay');
const params = new URLSearchParams(location.search);
const view = params.get('view') || 'console';
let state;
let filter = 'all';
let search = '';
let selected = params.get('topic') || 'OC-028';
const selectedJobs = new Map(params.get('job') ? [[selected, params.get('job')]] : []);
let returnFocus;
const paths = {
 pulse:'M3 12h4l3-8 4 16 3-8h4',grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 chat:'M21 11.5a8.4 8.4 0 0 1-9 8.5H3l2-5a8 8 0 0 1-1-4 8.5 8.5 0 0 1 17 .5Z M8 10h8 M8 14h5',
 book:'M4 3h6a3 3 0 0 1 3 3v15a4 4 0 0 0-4-2H3V4a1 1 0 0 1 1-1Z M13 6a3 3 0 0 1 3-3h5v16h-4a4 4 0 0 0-4 2',
 layers:'m12 3 10 6-10 6L2 9l10-6Z M2 13l10 6 10-6 M2 17l10 6 10-6',search:'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
 arrow:'M5 12h14 M14 7l5 5-5 5',chevron:'m8 4 8 8-8 8',down:'m5 9 7 7 7-7',check:'m5 12 4 4L19 6',close:'m6 6 12 12 M18 6 6 18',
 file:'M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8l-6-6Z M14 2v6h6 M8 13h8 M8 17h5',
 external:'M14 3h7v7 M21 3 11 13 M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6',
 clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',pause:'M8 5v14 M16 5v14',play:'m7 4 13 8-13 8V4Z',
 alert:'M12 8v5 M12 17h.01 M10 3 1 19h22L14 3h-4Z',terminal:'m4 7 5 5-5 5 M12 17h8',settings:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M9 15v6',
 plus:'M12 4v16 M4 12h16',attach:'m9 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9',send:'m3 3 19 9-19 9 4-9-4-9Z M7 12h15',
 checkcircle:'m7 12 3 3 7-7 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',folder:'M3 5h6l2 3h10v12H3V5Z',dots:'M5 12h.01 M12 12h.01 M19 12h.01',shield:'m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6l9-4Z m-4 10 3 3 5-6',edit:'m4 16 12-12 4 4L8 20H4v-4Z M13 7l4 4',link:'m10 13 4-4 M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M14 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const verificationLabels = {observed:'已观察',verified:'已验证',unverified:'未验证'};
function verificationBadge(value) {
  const label = verificationLabels[value];
  return label ? `<span class="badge verification ${value}" aria-label="结论验证状态：${label}">${icon(value === 'verified' ? 'check' : value === 'observed' ? 'file' : 'clock')}${label}</span>` : '';
}
function conclusionList(conclusions = []) {
  return conclusions.length ? `<div class="conclusions">${conclusions.map(c => `<div class="conclusion"><p>${esc(c.text)}</p>${verificationBadge(c.verification)}</div>`).join('')}</div>` : '';
}
function libraryPage(){const cases=state.cases.filter(c=>(filter==='all'||c.tag===filter||filter==='verified'&&c.conclusions.some(x=>x.verification==='verified'))&&`${c.title} ${c.summary} ${c.keywords.join(' ')}`.toLowerCase().includes(search.toLowerCase()));const featured=cases.find(c=>c.id==='KB-012');return `<div class="library"><header class="library-nav">${brand()}<nav class="horizontal-nav" aria-label="主导航"><a href="${link('console')}">运行概览</a><a href="${link('cases')}" class="active">案例库</a><a href="${link('workspace')}">工作区</a></nav><div class="row"><span class="tiny muted">infra-workspace</span><span class="avatar">我</span></div></header><main class="library-main"><div class="library-hero"><div><div class="eyebrow">COLLECTIVE KNOWLEDGE</div><h1>让每一次排查，<br>成为下一次的线索。</h1><p>把分散在话题里的证据、结论与修正，留在一起。</p><div class="library-stats"><span><b>${state.cases.length}</b>个案例</span><span><b>${state.cases.flatMap(c=>c.conclusions).filter(c=>c.verification==='verified').length}</b>条已验证结论</span><span><b>${state.cases.flatMap(c=>c.conclusions).filter(c=>c.verification==='unverified').length}</b>条未验证结论</span></div></div><div><label class="search">${icon('search')}<input id="case-search" aria-label="搜索案例" value="${esc(search)}" placeholder="搜索错误、现象或已有结论"></label><p class="tiny muted" style="margin-top:12px">同一业务工作区内，私聊与群聊案例共享</p></div></div><div class="collection-bar"><div class="filters">${[['all','全部案例'],['verified','含已验证结论'],['Sheet','Sheet'],['Slide','Slide'],['基础设施','基础设施'],['工具','工具']].map(([id,l])=>`<button class="filter ${filter===id?'active':''}" data-filter="${id}">${l}</button>`).join('')}</div><span class="tiny muted">按最近更新排序</span></div>${featured?`<article class="featured-case" role="button" tabindex="0" data-case="${featured.id}" aria-label="查看 ${featured.title}"><div><div class="row"><span class="tiny muted">最近更新 · ${featured.id}</span></div><h2>${featured.title}</h2><p>${featured.summary}</p><div class="featured-meta"><span>${featured.tag}</span><span>·</span><span>${featured.updated}</span><span>·</span><span>${featured.evidence.length} 条证据记录</span>${icon('arrow')}</div></div><div class="feature-proof"><h3>结论与验证</h3>${conclusionList(featured.conclusions)}</div></article>`:''}<div class="case-grid">${cases.filter(c=>c!==featured).map(c=>`<article class="case-card" role="button" tabindex="0" data-case="${c.id}" aria-label="查看 ${c.title}"><div class="row between"><span class="tag">${c.tag} / ${c.id}</span></div><h3>${c.title}</h3><p>${c.summary}</p>${conclusionList(c.conclusions)}<div class="tags">${c.keywords.map(k=>`<span>${k}</span>`).join('')}</div><div class="card-bottom"><span>${c.updated}</span><span>${c.evidence.length} 条证据记录</span></div></article>`).join('')}</div>${!cases.length?'<div class="empty">没有找到匹配的案例</div>':''}<footer class="library-footer"><span>${cases.length} 个案例 · 结论保留来源轮次</span><span>${state.cases.length} 个话题案例</span></footer></main></div>`;}

const executionLabels = {preparing:'准备中',queued:'排队中',running:'执行中',cancel_requested:'正在停止',succeeded:'已完成',failed:'执行失败',cancelled:'已取消',interrupted:'已中断'};
const deliveryLabels = {pending:'等待发送',delivering:'正在发送',delivered:'已发送',abandoned:'发送失败'};
const activeStatuses = ['preparing','running','cancel_requested'];
const brand = () => `<div class="brand"><span class="brand-mark">${icon('pulse')}</span>oncall<small>SPACE</small></div>`;
const link = (name,topic,job) => `?view=${name}${topic ? '&topic='+encodeURIComponent(topic) : ''}${job ? '&job='+encodeURIComponent(job) : ''}`;
function badge(kind,label){return `<span class="badge ${kind}">${esc(label)}</span>`;}
function executionBadge(job){return badge(job.executionStatus,executionLabels[job.executionStatus] || '状态未知');}
function deliveryBadge(job){return badge(job.replyState || 'none',job.replyState ? deliveryLabels[job.replyState] || '状态未知' : '暂无最终回复');}
function topicBadge(t){return badge(t.paused ? 'paused' : 'open',t.paused ? '话题已暂停' : '话题未暂停');}
function currentJob(t){return t.jobs.find(j=>activeStatuses.includes(j.executionStatus)) || t.jobs.at(-1);}
function queuedCount(t){return t.jobs.filter(j=>j.executionStatus==='queued').length;}
function needsAttention(t){const j=currentJob(t);return t.paused || ['failed','interrupted','cancel_requested'].includes(j.executionStatus) || t.jobs.some(job=>job.replyState==='abandoned');}
function caseForJob(jobId){return state.cases.find(c=>c.jobId===jobId);}
function evidenceList(items=[]){
  if(!items.length)return '<p class="muted evidence-empty">暂无证据记录</p>';
  return `<div class="evidence-text-list">${items.map(text=>`<div class="evidence-row">${icon('file')}<span>${evidenceText(text)}</span></div>`).join('')}</div>`;
}
function evidenceText(text){
  return String(text).split(/(https?:\/\/[^\s<>"'，。；）]+)/g).map(part=>{
    if(!/^https?:\/\//.test(part))return esc(part);
    try {const url=new URL(part); if(!['https:','http:'].includes(url.protocol))return esc(part);return `<a class="source-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>`;} catch{return esc(part);}
  }).join('');
}
function statusFacts(t,j=currentJob(t)){
  return `<dl class="status-facts"><div><dt>话题</dt><dd>${topicBadge(t)}</dd></div><div><dt>当前执行 · ${esc(j.id)}</dt><dd>${executionBadge(j)}</dd></div><div><dt>排队请求</dt><dd>${queuedCount(t)} 条</dd></div><div><dt>当前轮次回复</dt><dd>${deliveryBadge(j)}</dd></div></dl>`;
}
function nav(active){return `<nav class="nav" aria-label="主导航">${[['console','grid','运行概览'],['desk','chat','话题记录'],['cases','book','案例库'],['workspace','settings','工作区']].map(([id,i,name])=>`<a href="${link(id)}" class="${active===id?'active':''}">${icon(i)}${name}</a>`).join('')}</nav>`;}
function shell(body,active='console'){
  return `<div class="shell"><aside class="sidebar">${brand()}<a href="${link('workspace')}" class="work-selector">${icon('layers')}${esc(state.workspace)}</a><div class="section-label">WORKSPACE</div>${nav(active)}<div class="sidebar-bottom"><span class="tiny muted">${state.topics.length} 个话题 · ${state.cases.length} 个案例</span></div></aside><main><header class="topbar"><div class="breadcrumb">工作空间 <span>/</span><span>${active==='workspace'?'业务关联':'运行概览'}</span></div><div class="topbar-right"><span class="tiny muted">快照时间 ${esc(state.health.sampledAt)}</span><span class="avatar">我</span></div></header>${body}</main></div>`;
}
function consolePage(){
  const filtered=state.topics.filter(t=>(filter==='all'||filter==='attention'&&needsAttention(t)||currentJob(t).executionStatus===filter)&&`${t.title} ${t.description} ${t.id} ${t.area}`.toLowerCase().includes(search.toLowerCase()));
  const jobs=state.topics.flatMap(t=>t.jobs);
  const failedReplyTopic=state.topics.find(t=>t.jobs.some(j=>j.replyState==='abandoned'));
  const metrics=[['执行占用',jobs.filter(j=>['running','cancel_requested'].includes(j.executionStatus)).length+' / '+state.maxConcurrentJobs,'包含正在停止的执行'],['需关注话题',state.topics.filter(needsAttention).length,'暂停、执行异常或回复发送失败'],['排队请求',jobs.filter(j=>j.executionStatus==='queued').length,'按请求计数'],['回复发送失败',jobs.filter(j=>j.replyState==='abandoned').length,'按执行轮次计数']];
  return shell(`<div class="content"><div class="page-heading"><div><div class="eyebrow">OPERATIONS</div><h1>运行概览</h1><p>查看话题、执行轮次与回复发送情况。</p></div><a class="button" href="${link('desk')}">${icon('chat')}查看话题记录${icon('arrow')}</a></div><section class="metric-row" aria-label="任务概况">${metrics.map(([name,value,hint])=>`<div class="metric"><div class="label">${name}</div><span class="number">${value}</span><span class="hint">${hint}</span></div>`).join('')}</section><div class="dashboard"><section class="panel"><div class="panel-title"><h2>话题动态 <span class="muted tiny">${state.topics.length}</span></h2></div><div class="filters">${[['all','全部'],['attention','需关注'],['running','执行中'],['succeeded','本轮已完成']].map(([id,label])=>`<button class="filter ${filter===id?'active':''}" data-filter="${id}">${label}</button>`).join('')}<label class="search list-search">${icon('search')}<input id="topic-search" aria-label="搜索话题" placeholder="搜索话题或编号" value="${esc(search)}"></label></div><div class="topics-header"><span>问题 / 话题</span><span>当前执行 / 回复</span><span class="topic-source">来源</span><span class="topic-owner">发起人</span></div><div id="topic-list">${filtered.length?filtered.map(t=>`<div class="topic-row" role="button" tabindex="0" data-topic="${t.id}" aria-label="查看 ${esc(t.title)}"><div><span class="topic-title">${esc(t.title)}</span><span class="topic-sub">${esc(t.id)} · ${t.paused?'话题已暂停':'话题未暂停'} · 排队 ${queuedCount(t)}</span></div><div class="row-status">${executionBadge(currentJob(t))}${deliveryBadge(currentJob(t))}</div><span class="topic-source tiny muted">${esc(t.source)}</span><span class="avatar">${esc(t.owner)}</span></div>`).join(''):'<div class="empty">没有找到匹配的话题</div>'}</div></section><aside class="right-column">${failedReplyTopic?`<section class="panel attention-card"><div class="small-title">${icon('alert')}回复发送失败</div><h3>${esc(failedReplyTopic.title)}</h3><p>有执行轮次的最终回复未送达飞书。</p><button class="button small" data-topic="${failedReplyTopic.id}">查看记录${icon('arrow')}</button></section>`:''}<section class="panel"><div class="panel-title"><h2>服务快照</h2></div><div class="setting-body"><div class="setting-row"><div><b>机器人进程</b><small>${esc(state.health.sampledAt)}</small></div><span>${esc({running:'运行中',starting:'启动中',stopping:'停止中',stopped:'已停止'}[state.health.state] || '未知')}</span></div><div class="setting-row"><span>快照状态</span><span>${state.health.sampleStatus==='fresh'?'有效':'已过期'}</span></div></div></section><section class="panel"><div class="panel-title"><h2>最近案例</h2><a href="${link('cases')}" aria-label="查看案例库">${icon('arrow')}</a></div>${state.cases.slice(0,3).map(c=>`<a href="${link('cases')}&case=${c.id}" class="recent-case"><b>${esc(c.title)}</b><span>${c.conclusions.length} 条结论 · ${esc(c.jobId)}</span></a>`).join('')}</section></aside></div><div class="footnote"><span>${esc(state.workspace)} · ${state.bindings.groups.length} 个关联群 · 1 个私聊入口</span><span>执行结果与发送状态分别记录</span></div></div>`);
}
function rounds(t,chosen){
  return `<section class="rounds"><h2>执行轮次 <span class="tiny muted">${t.jobs.length}</span></h2><div class="round-list">${[...t.jobs].reverse().map((j)=>`<button class="round-item ${j.id===chosen.id?'active':''}" data-job="${j.id}" aria-pressed="${j.id===chosen.id}"><span class="mono">${esc(j.id)}</span>${executionBadge(j)}<span class="tiny muted">${esc(j.createdAt)}</span></button>`).join('')}</div></section>`;
}
function deskPage(){
  const t=state.topics.find(t=>t.id===selected)||state.topics[0];selected=t.id;
  const j=t.jobs.find(j=>j.id===selectedJobs.get(t.id))||currentJob(t);
  const c=caseForJob(j.id);
  return `<div class="desk"><aside class="rail"><a href="${link('console')}" aria-label="运行概览"><span class="brand-mark">${icon('pulse')}</span></a><a href="${link('desk')}" class="active" aria-label="话题记录">${icon('chat')}</a><a href="${link('cases')}" aria-label="案例库">${icon('book')}</a><a href="${link('workspace')}" aria-label="工作区">${icon('layers')}</a></aside><aside class="inbox"><div class="inbox-head"><h2>话题</h2><p>${esc(state.workspace)}</p></div><div class="inbox-tabs"><button class="${filter==='all'?'active':''}" data-filter="all">全部</button><button class="${filter==='attention'?'active':''}" data-filter="attention">需要关注</button></div><div class="inbox-list">${state.topics.filter(t=>filter==='all'||needsAttention(t)).map(item=>`<button class="inbox-item ${t.id===item.id?'active':''}" data-select-topic="${item.id}"><div class="row between">${executionBadge(currentJob(item))}<span class="tiny muted">排队 ${queuedCount(item)}</span></div><h3>${esc(item.title)}</h3><small>${esc(item.id)} · ${item.paused?'话题已暂停':'话题未暂停'}</small>${currentJob(item).replyState==='abandoned'?'<p class="delivery-warning">回复发送失败</p>':''}</button>`).join('')}</div></aside><main class="desk-main"><header class="desk-top"><div><div class="mono">${esc(t.id)} / ${esc(t.source)}</div><h1>${esc(t.title)}</h1></div>${topicBadge(t)}</header><div class="desk-status">${statusFacts(t)}</div><div class="desk-body"><section class="conversation">${rounds(t,j)}<section class="round-record" aria-label="所选轮次"><div class="selected-round"><h2>${esc(j.id)}</h2><span>执行 ${executionBadge(j)}</span><span>最终回复 ${deliveryBadge(j)}</span></div><div class="message"><span class="avatar">${esc(t.owner)}</span><div><div class="name">本轮请求 <time>${esc(j.createdAt)}</time></div><div class="user-bubble"><p>${esc(j.request)}</p></div></div></div><div class="message"><span class="avatar bot">${icon('pulse')}</span><div><div class="name">Oncall</div><div class="analysis-block"><div class="analysis-heading"><b>${j.resultText?'本轮执行结果':'本轮进展'}</b></div><p class="result-text">${esc(j.resultText || j.progress || '尚未开始执行')}</p>${c?conclusionList(c.conclusions):''}</div>${j.replyState==='abandoned'?'<div class="delivery-warning">最终回复发送失败</div>':''}</div></div></section></section><aside class="evidence-panel"><h2>${icon('file')}本轮证据记录 <span class="count">${c?.evidence.length || 0}</span></h2>${evidenceList(c?.evidence)}${c?`<section class="right-section"><h2>${icon('book')}本轮案例</h2><a class="related-small" href="${link('cases')}&case=${c.id}"><b>${esc(c.title)}</b><span>${esc(c.id)} · ${esc(c.jobId)} ${icon('arrow')}</span></a></section>`:''}<section class="right-section"><h2>来源</h2><p class="source-note">${esc(t.source)}<br>${esc(t.id)} · ${esc(j.id)}</p></section></aside></div></main></div>`;
}
function workspacePage(){
  const rows=items=>items.map(([title,detail])=>`<div class="setting-row"><div><b>${esc(title)}</b><small>${esc(detail)}</small></div></div>`).join('');
  return shell(`<div class="content"><div class="page-heading"><div><div class="eyebrow">WORKSPACE</div><h1>业务工作区</h1><p>查看机器人使用的业务关联与资料配置。</p></div></div><div class="workspace-grid"><section class="panel"><div class="panel-title"><h2>${esc(state.workspace)}</h2></div><div class="setting-body">${rows([...state.bindings.groups.map(g=>[g,'群聊绑定']),[state.bindings.private,'私聊绑定']])}</div></section><section class="panel"><div class="panel-title"><h2>关联仓库</h2><span class="tiny muted">${state.repositories.length} 个</span></div><div class="setting-body">${rows(state.repositories.map(r=>[r.name,r.description]))}</div></section><section class="panel"><div class="panel-title"><h2>知识资料</h2></div><div class="setting-body">${rows(state.knowledgePaths.map(p=>[p,'资料路径']))}</div></section><section class="panel"><div class="panel-title"><h2>执行配置</h2></div><div class="setting-body">${rows([['最大并行执行数',String(state.maxConcurrentJobs)],['同话题请求','按顺序执行'],['中断恢复','明确继续后先核对现场']])}</div></section></div></div>`,'workspace');
}
function render(){app.innerHTML=view==='cases'?libraryPage():view==='desk'?deskPage():view==='workspace'?workspacePage():consolePage();document.title=`Oncall · ${{console:'运行概览',cases:'案例库',desk:'话题记录',workspace:'业务工作区'}[view]||'运行概览'}`;}
function closeOverlay(){overlay.innerHTML='';document.body.style.overflow='';returnFocus?.focus();}
function drawer(content){returnFocus=document.activeElement;overlay.innerHTML=`<div class="drawer-backdrop" data-dismiss="backdrop"><section class="drawer" role="dialog" aria-modal="true" aria-label="详情">${content}</section></div>`;document.body.style.overflow='hidden';overlay.querySelector('button')?.focus();}
function drawerHeader(text){return `<div class="drawer-head"><span class="mono muted">${esc(text)}</span><button class="icon-button" data-dismiss="close" aria-label="关闭详情">${icon('close')}</button></div>`;}
function topicDetail(id){
  const t=state.topics.find(t=>t.id===id);if(!t)return;const j=currentJob(t);const c=caseForJob(j.id);
  drawer(`${drawerHeader('话题 / '+t.id)}<h1>${esc(t.title)}</h1><div class="meta">${esc(t.source)}</div>${statusFacts(t)}<div class="drawer-section"><h2>当前轮次 · ${esc(j.id)}</h2><p class="drawer-summary result-text">${esc(j.resultText || j.progress || '尚未开始执行')}</p>${c?conclusionList(c.conclusions):''}</div><div class="drawer-section"><h2>执行轮次</h2><div class="timeline">${[...t.jobs].reverse().map(job=>`<div><small>${esc(job.createdAt)} · ${esc(job.id)}</small><p>${executionBadge(job)} ${deliveryBadge(job)}</p></div>`).join('')}</div></div><div class="drawer-actions"><a class="button primary" href="${link('desk',t.id)}">查看话题记录${icon('arrow')}</a></div>`);
}
function caseDetail(id){
  const c=state.cases.find(c=>c.id===id);if(!c)return;
  drawer(`${drawerHeader('案例 / '+c.id)}<h1>${esc(c.title)}</h1><div class="meta">${esc(c.tag)} · ${esc(c.updated)}</div><div class="drawer-section"><h2>案例摘要</h2><p class="drawer-summary">${esc(c.summary)}</p></div><div class="drawer-section"><h2>结论与验证</h2>${conclusionList(c.conclusions)}</div><div class="drawer-section"><h2>证据记录</h2>${evidenceList(c.evidence)}</div><div class="drawer-section"><h2>来源轮次</h2><p class="mono">${esc(c.topicId)} · ${esc(c.jobId)}</p></div><div class="drawer-actions"><a class="button" href="${link('desk',c.topicId,c.jobId)}">查看来源轮次${icon('arrow')}</a></div>`);
}
document.addEventListener('click',event=>{
  if(event.target.dataset.dismiss==='backdrop'){closeOverlay();return;}
  const el=event.target.closest('button,[data-topic],[data-case]');if(!el)return;
  if(el.dataset.dismiss){closeOverlay();return;}
  if(el.dataset.filter){filter=el.dataset.filter;render();return;}
  if(el.dataset.topic){topicDetail(el.dataset.topic);return;}
  if(el.dataset.case){caseDetail(el.dataset.case);return;}
  if(el.dataset.selectTopic){selected=el.dataset.selectTopic;render();return;}
  if(el.dataset.job){selectedJobs.set(selected,el.dataset.job);render();}
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape')closeOverlay();
  if(['Enter',' '].includes(event.key)&&event.target.matches('[data-topic],[data-case]')){event.preventDefault();event.target.click();}
  if(event.key==='Tab'&&overlay.firstElementChild){const focusable=[...overlay.querySelectorAll('button,a[href]')];const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
});
document.addEventListener('input',event=>{
  if(!['topic-search','case-search'].includes(event.target.id))return;
  const id=event.target.id,pos=event.target.selectionStart;search=event.target.value;render();const input=document.getElementById(id);input.focus();input.setSelectionRange(pos,pos);
});
fetch('./mock-state.json').then(r=>{if(!r.ok)throw new Error('无法读取数据');return r.json();}).then(data=>{state=data;render();if(params.get('case'))caseDetail(params.get('case'));}).catch(()=>{app.innerHTML='<div class="empty"><h1>页面暂时无法加载</h1><p>请刷新后重试</p></div>';});
