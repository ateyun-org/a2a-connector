import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { controlContract } from '../control-contract.js';
import { RemoteSelection } from './remote-selection.js';
import { HistoryMenu } from './history-menu.jsx';

async function call(remote, method, input) {
  const result = await (input === undefined ? remote[method]() : remote[method](input));
  if (!result.ok) throw new Error(result.error?.message || '请求失败，请稍后重试。');
  return result.value;
}

function RobotIcon() {
  return <svg className="a2a-remote-robot" width="20" height="20" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 7V3H9M4 12H2v4h2m16-4h2v4h-2" />
    <rect x="4" y="7" width="16" height="14" rx="4" />
    <path d="M9 12v2m6-2v2m-6 3h6" />
  </svg>;
}

function DirectChatStatus({ sessionId, selection }) {
  const state = useSyncExternalStore(selection.subscribe, selection.getSnapshot);
  const active = selection.current === sessionId ? state.agentId : null;
  const agentId = active || selection.bindings.get(sessionId);
  if (!agentId) return null;
  const target = selection.targets.get(agentId);
  return <div className="a2a-direct-status" role="status">
    <div className="a2a-direct-info"><RobotIcon /><span><strong>{active && state.pending ? '正在连接' : '直聊'} · {target?.name || agentId}</strong>
      <small title="消息直接发送给远程 Agent，无需选择主控模型">消息直接发送给远程 Agent，无需选择主控模型</small></span></div>
  </div>;
}

function RemoteAgents({ remote, selection, expandSidebar, wide = true, useSessions }) {
  const [expanded, setExpanded] = useState(true), [targets, setTargets] = useState(null);
  const [error, setError] = useState('');
  const selected = useSyncExternalStore(selection.subscribe, selection.getSnapshot);
  const sessions = useSessions(state => state.byId);
  const history = Object.values(sessions).filter(row => selection.bindings.get(row.id) === selected.agentId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  useEffect(() => {
    let gone = false, loading = false;
    const refresh = async () => {
      if (loading) return; loading = true;
      try { const list = await call(remote, 'targets'); if (!gone) { selection.setTargets(list); setTargets(list); setError(''); } }
      catch (error) { if (!gone) setError(error.message); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { gone = true; clearInterval(timer); };
  }, [remote, selection]);

  if (!wide) return <button type="button" className="a2a-remote-rail" aria-label="展开远程 Agents" title="远程 Agents"
    onClick={() => { setExpanded(true); expandSidebar(); }}><RobotIcon /></button>;
  return <section className="a2a-remote-agents" aria-label="可控制的远程 Agent">
    <div className="a2a-remote-toolbar">
    <button type="button" className="a2a-remote-heading" aria-expanded={expanded} aria-controls="a2a-remote-list"
      onClick={() => setExpanded(value => !value)}><RobotIcon />
      <span className="a2a-remote-heading-label">远程 Agents</span><small>{targets?.length ?? '…'}</small>
      <svg className="a2a-remote-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="m9 6 6 6-6 6" />
      </svg></button>
      <HistoryMenu key={selected.agentId || 'none'} agentId={selected.agentId}
        name={targets?.find(target => target.agentId === selected.agentId)?.name || selected.agentId || '远程 Agent'}
        rows={history} currentId={selected.sessionId} pending={selected.pending}
        onSelect={sessionId => selection.select(selected.agentId, { sessionId })} />
    </div>
    {expanded && <div id="a2a-remote-list" className="a2a-remote-list">
      {(error || selected.error) && <p role="alert">{error || selected.error}</p>}
      {selected.agentId && <button type="button" className="a2a-remote-local" disabled={selected.pending}
        onClick={() => void selection.local()}>返回本地 DSH</button>}
      {targets === null && !error && <p role="status">正在读取授权列表…</p>}
      {targets?.length === 0 && <p>暂无可控制的 Agent，请由管理员配置调用授权。</p>}
      {targets?.map(target => <React.Fragment key={target.agentId}>
        <div className="a2a-remote-item" data-agent-id={target.agentId} data-selected={selected.agentId === target.agentId ? '' : undefined}
          role="group" aria-label={target.name || target.agentId}>
        <button type="button" className="a2a-remote-row"
        aria-current={selected.agentId === target.agentId ? 'page' : undefined} disabled={selected.pending && selected.agentId === target.agentId}
        onClick={() => void selection.select(target.agentId)}>
        <span className="a2a-remote-name">{target.name || target.agentId}</span>
        <span className="a2a-remote-status"><i className={!target.online ? 'offline' : target.busy ? 'busy' : 'online'} />
          {selected.pending && selected.agentId === target.agentId ? '正在打开…' : !target.online ? '离线' : target.connectionStatus === 'hosted_ready'
            ? (target.busy ? '接收端就绪 · 忙碌' : '接收端就绪 · 空闲') : target.busy ? '在线 · 忙碌' : '在线 · 空闲'}
          {target.queuedTasks > 0 && ` · 排队 ${target.queuedTasks}`}</span>
        </button>
        <button type="button" className="a2a-remote-new" aria-label="新建聊天" title={`与 ${target.name || target.agentId} 新建聊天`}
          disabled={selected.pending && selected.agentId === target.agentId} onClick={() => void selection.newChat(target.agentId)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M16 3a2.12 2.12 0 0 1 3 3l-9 9-4 1 1-4Z" />
          </svg>
        </button>
        </div>
      </React.Fragment>)}
    </div>}
  </section>;
}

export const inject = ['slots', 'remote', 'sessions', 'uiWorkspace', 'layout', 'conversation'];
export function apply(ctx) {
  ctx.effect(() => ctx.remote.$mount(controlContract));
  ctx.inject(['remote.a2aControl'], scope => {
    let storage;
    try { storage = window.sessionStorage; } catch {}
    const selection = new RemoteSelection(scope, scope.remote.a2aControl, storage);
    scope.effect(() => selection.start());
    scope.slots.inject('sidebar.footer.action', () => scope.slots.register({ name: 'sidebar.footer.action', id: 'a2a-remote-agents', order: -10,
      inject: () => ({ remote: scope.remote.a2aControl, selection,
        expandSidebar: () => scope.layout.toggleSidebar() }) }, RemoteAgents));
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({ name: 'conversation.input.dock', id: 'a2a-direct-chat', order: -20,
      inject: () => ({ selection }) }, DirectChatStatus));
    scope.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'dsh-a2a-connector'; style.textContent = css; document.head.append(style); return () => style.remove(); });
  });
}

const css = `
.a2a-remote-agents{box-sizing:border-box;flex:1;min-width:0;width:100%;color:var(--dsw-alias-label-primary,inherit);font:inherit;padding:4px var(--dsh-sidebar-inline-padding,8px)}
.a2a-remote-agents button,.a2a-remote-rail{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer;border-radius:6px}
.a2a-remote-toolbar{display:flex;align-items:center;gap:2px;min-width:0}.a2a-remote-heading{display:flex;align-items:center;gap:8px;flex:1;width:0;min-width:0;height:32px;padding:0 8px;text-align:left;font-size:13px!important}
.a2a-remote-heading-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.a2a-remote-robot,.a2a-remote-chevron{display:block;flex:none}.a2a-remote-heading .a2a-remote-robot{width:18px;height:18px}
.a2a-remote-chevron{opacity:.5;transition:transform 140ms ease}.a2a-remote-heading[aria-expanded=true] .a2a-remote-chevron{transform:rotate(90deg)}
.a2a-remote-heading small{margin-left:auto;opacity:.6}.a2a-remote-list{max-height:min(35vh,300px);overflow:auto;display:grid;gap:2px}
.a2a-remote-list p{font-size:12px;line-height:1.6;padding:8px;margin:0;overflow-wrap:anywhere;opacity:.7}.a2a-remote-list [role=alert]{color:var(--dsw-alias-status-error,#b74b42)}
.a2a-remote-local{font-size:11px!important;text-align:left;padding:5px 12px 5px 34px;opacity:.65}.a2a-remote-local:hover{opacity:1;text-decoration:underline}
.a2a-direct-status{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 4px;color:var(--dsw-alias-label-primary,inherit);font:inherit}
.a2a-direct-info{display:flex;align-items:center;gap:8px;min-width:0;flex:1}.a2a-direct-info>span{display:grid;gap:2px;min-width:0;flex:1}.a2a-direct-status strong{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.a2a-direct-status small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;line-height:1.5;opacity:.65;overflow-wrap:anywhere}
.a2a-remote-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;min-width:0;border-radius:6px}
.a2a-remote-new,.a2a-remote-history-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;margin-inline-end:6px;opacity:.6;flex:none}
.a2a-remote-item:hover>.a2a-remote-new,.a2a-remote-new:focus-visible{opacity:1}
.a2a-remote-new:disabled{opacity:.5;cursor:wait}.a2a-remote-new:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}.a2a-remote-new:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#52796f);outline-offset:1px}
.a2a-remote-history-trigger:hover,.a2a-remote-history-trigger[aria-expanded=true]{opacity:1;background:var(--dsw-alias-interactive-bg-hover,#8881)}
.a2a-remote-history-menu{box-sizing:border-box;position:fixed;inset:auto;margin:0;padding:6px;width:min(320px,calc(100vw - 24px));max-height:min(400px,calc(100dvh - 24px));border:1px solid var(--dsw-alias-border-l1,#8884);border-radius:10px;background:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-elevation-prominent,0 12px 36px #0002);font:inherit}
.a2a-remote-history-menu:popover-open{display:flex;flex-direction:column}.a2a-remote-history-menu button{font:inherit;color:inherit;background:transparent;border:0;border-radius:6px;cursor:pointer}
.a2a-remote-history-header{display:flex;align-items:center;gap:8px;padding:3px 6px 7px;border-bottom:1px solid var(--dsw-alias-border-l1,#8882)}.a2a-remote-history-header strong{font-size:12px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.a2a-remote-history-header small{font-size:11px;opacity:.6}.a2a-remote-history-header button{display:flex;align-items:center;justify-content:center;height:24px;width:24px;padding:0;flex:none}
.a2a-remote-history-entries{overflow:auto;min-height:0;overscroll-behavior:contain;padding-top:4px}.a2a-remote-history-entries p{font-size:12px;padding:12px;opacity:.6}
.a2a-remote-history-row{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;text-align:left;padding:6px 8px;margin-top:1px;font-size:12px!important}
.a2a-remote-history-check{display:flex;width:12px;flex:none}.a2a-remote-history-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.a2a-remote-history-row time{font-size:10px;opacity:.6;white-space:nowrap}.a2a-remote-history-running{height:6px;width:6px;border-radius:50%;background:#bd8826;flex:none}
.a2a-remote-history-row:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}.a2a-remote-history-row[aria-current=page]{background:var(--dsw-alias-interactive-bg-selected,#52796f22)}
.a2a-remote-history-menu button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#52796f);outline-offset:-2px}
.a2a-remote-row{display:grid;gap:4px;width:100%;padding:8px 12px 8px 34px;text-align:left;min-width:0}
.a2a-remote-item:hover,.a2a-remote-heading:hover,.a2a-remote-rail:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}
.a2a-remote-item[data-selected]{background:var(--dsw-alias-interactive-bg-selected,#52796f22)}
.a2a-remote-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.a2a-remote-status{font-size:11px;display:flex;align-items:center;gap:5px;opacity:.7;flex-wrap:wrap}
.a2a-remote-status i{height:6px;width:6px;border-radius:50%;background:#90969a;flex:none}.a2a-remote-status i.online{background:#42816c}.a2a-remote-status i.busy{background:#bd8826}
.a2a-remote-rail{display:inline-flex;align-items:center;justify-content:center;height:36px;width:36px;padding:0}.a2a-remote-agents button:disabled{opacity:.5;cursor:wait}.a2a-remote-agents button:focus-visible,.a2a-remote-rail:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#52796f);outline-offset:1px}
@media(prefers-reduced-motion:reduce){.a2a-remote-chevron{transition:none}}
`;
