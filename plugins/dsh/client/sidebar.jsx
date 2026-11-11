import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { controlContract } from '../control-contract.js';
import { RemoteSelection } from './remote-selection.js';

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
    <button type="button" className="a2a-remote-new" disabled={state.pending}
      onClick={() => void selection.newChat(agentId, sessionId)}>新建聊天</button>
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
    <button type="button" className="a2a-remote-heading" aria-expanded={expanded} aria-controls="a2a-remote-list"
      onClick={() => setExpanded(value => !value)}><RobotIcon />
      <span>远程 Agents</span><small>{targets?.length ?? '…'}</small>
      <svg className="a2a-remote-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="m9 6 6 6-6 6" />
      </svg></button>
    {expanded && <div id="a2a-remote-list" className="a2a-remote-list">
      {(error || selected.error) && <p role="alert">{error || selected.error}</p>}
      {selected.agentId && <button type="button" className="a2a-remote-local" disabled={selected.pending}
        onClick={() => void selection.local()}>返回本地 DSH</button>}
      {targets === null && !error && <p role="status">正在读取授权列表…</p>}
      {targets?.length === 0 && <p>暂无可控制的 Agent，请由管理员配置调用授权。</p>}
      {targets?.map(target => <React.Fragment key={target.agentId}><button type="button" className="a2a-remote-row"
        aria-current={selected.agentId === target.agentId ? 'page' : undefined} disabled={selected.pending && selected.agentId === target.agentId}
        onClick={() => void selection.select(target.agentId)}>
        <span className="a2a-remote-name">{target.name || target.agentId}</span>
        <span className="a2a-remote-status"><i className={!target.online ? 'offline' : target.busy ? 'busy' : 'online'} />
          {selected.pending && selected.agentId === target.agentId ? '正在打开…' : !target.online ? '离线' : target.connectionStatus === 'hosted_ready'
            ? (target.busy ? '接收端就绪 · 忙碌' : '接收端就绪 · 空闲') : target.busy ? '在线 · 忙碌' : '在线 · 空闲'}
          {target.queuedTasks > 0 && ` · 排队 ${target.queuedTasks}`}</span>
      </button>
        {selected.agentId === target.agentId && <div className="a2a-remote-chats">
          <button type="button" className="a2a-remote-new" disabled={selected.pending}
            onClick={() => void selection.newChat(target.agentId)}>新建聊天</button>
          <details className="a2a-remote-history">
            <summary>聊天记录（{history.length}）</summary>
            {history.map(row => <button type="button" key={row.id} className="a2a-remote-history-row"
              data-session-id={row.id}
              aria-current={selected.sessionId === row.id ? 'page' : undefined} disabled={selected.pending}
              onClick={() => void selection.select(target.agentId, { sessionId: row.id })}>
              <span>{row.title || row.displayTitle || '聊天记录'}</span>
              <small>{row.updatedAt ? new Date(row.updatedAt).toLocaleString(undefined, {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
              }) : '新聊天'}{row.running ? ' · 运行中' : ''}</small>
            </button>)}
          </details>
        </div>}
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
.a2a-remote-heading{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;text-align:left;font-size:13px!important}
.a2a-remote-robot,.a2a-remote-chevron{display:block;flex:none}.a2a-remote-heading .a2a-remote-robot{width:18px;height:18px}
.a2a-remote-chevron{opacity:.5;transition:transform 140ms ease}.a2a-remote-heading[aria-expanded=true] .a2a-remote-chevron{transform:rotate(90deg)}
.a2a-remote-heading small{margin-left:auto;opacity:.6}.a2a-remote-list{max-height:min(35vh,300px);overflow:auto;display:grid;gap:2px}
.a2a-remote-list p{font-size:12px;line-height:1.6;padding:8px;margin:0;overflow-wrap:anywhere;opacity:.7}.a2a-remote-list [role=alert]{color:var(--dsw-alias-status-error,#b74b42)}
.a2a-remote-local{font-size:11px!important;text-align:left;padding:5px 12px 5px 34px;opacity:.65}.a2a-remote-local:hover{opacity:1;text-decoration:underline}
.a2a-direct-status{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 4px;color:var(--dsw-alias-label-primary,inherit);font:inherit}
.a2a-direct-status{flex-wrap:wrap}.a2a-direct-info{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 180px}.a2a-direct-info>span{display:grid;gap:2px;min-width:0;flex:1}.a2a-direct-status strong{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.a2a-direct-status small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;line-height:1.5;opacity:.65;overflow-wrap:anywhere}
.a2a-remote-new{font:inherit;font-size:12px!important;color:inherit;background:transparent;border:1px solid var(--dsw-alias-outline-default,#8884);border-radius:6px;padding:5px 9px;cursor:pointer;white-space:nowrap;flex:none}
.a2a-direct-status>.a2a-remote-new{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.a2a-remote-new:disabled{opacity:.5;cursor:wait}.a2a-remote-new:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}.a2a-remote-new:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#52796f);outline-offset:1px}
.a2a-remote-chats{margin:0 8px 6px 34px;min-width:0}.a2a-remote-history{font-size:11px;margin-top:8px}.a2a-remote-history summary{cursor:pointer;opacity:.65;padding:4px 0}
.a2a-remote-history-row{display:grid;gap:3px;width:100%;text-align:left;padding:7px 8px;margin-top:2px}.a2a-remote-history-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.a2a-remote-history-row small{opacity:.6;font-size:10px}
.a2a-remote-history-row:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}.a2a-remote-history-row[aria-current=page]{background:var(--dsw-alias-interactive-bg-selected,#52796f22)}
.a2a-remote-row{display:grid;gap:4px;width:100%;padding:8px 12px 8px 34px;text-align:left;min-width:0}
.a2a-remote-row:hover,.a2a-remote-heading:hover,.a2a-remote-rail:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}
.a2a-remote-row[aria-current=page]{background:var(--dsw-alias-interactive-bg-selected,#52796f22)}
.a2a-remote-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.a2a-remote-status{font-size:11px;display:flex;align-items:center;gap:5px;opacity:.7;flex-wrap:wrap}
.a2a-remote-status i{height:6px;width:6px;border-radius:50%;background:#90969a;flex:none}.a2a-remote-status i.online{background:#42816c}.a2a-remote-status i.busy{background:#bd8826}
.a2a-remote-rail{display:inline-flex;align-items:center;justify-content:center;height:36px;width:36px;padding:0}.a2a-remote-agents button:disabled{opacity:.5;cursor:wait}.a2a-remote-agents button:focus-visible,.a2a-remote-rail:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#52796f);outline-offset:1px}
@media(prefers-reduced-motion:reduce){.a2a-remote-chevron{transition:none}}
`;
