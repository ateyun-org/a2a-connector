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

function RemoteAgents({ remote, selection, expandSidebar, wide = true }) {
  const [expanded, setExpanded] = useState(true), [targets, setTargets] = useState(null);
  const [error, setError] = useState('');
  const selected = useSyncExternalStore(selection.subscribe, selection.getSnapshot);
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
      {targets?.map(target => <button type="button" key={target.agentId} className="a2a-remote-row"
        aria-current={selected.agentId === target.agentId ? 'page' : undefined} disabled={selected.pending && selected.agentId === target.agentId}
        onClick={() => void selection.select(target.agentId)}>
        <span className="a2a-remote-name">{target.name || target.agentId}</span>
        <span className="a2a-remote-status"><i className={!target.online ? 'offline' : target.busy ? 'busy' : 'online'} />
          {selected.pending && selected.agentId === target.agentId ? '正在打开…' : !target.online ? '离线' : target.connectionStatus === 'hosted_ready'
            ? (target.busy ? '接收端就绪 · 忙碌' : '接收端就绪 · 空闲') : target.busy ? '在线 · 忙碌' : '在线 · 空闲'}
          {target.queuedTasks > 0 && ` · 排队 ${target.queuedTasks}`}</span>
      </button>)}
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
.a2a-remote-row{display:grid;gap:4px;width:100%;padding:8px 12px 8px 34px;text-align:left;min-width:0}
.a2a-remote-row:hover,.a2a-remote-heading:hover,.a2a-remote-rail:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}
.a2a-remote-row[aria-current=page]{background:var(--dsw-alias-interactive-bg-selected,#52796f22)}
.a2a-remote-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.a2a-remote-status{font-size:11px;display:flex;align-items:center;gap:5px;opacity:.7;flex-wrap:wrap}
.a2a-remote-status i{height:6px;width:6px;border-radius:50%;background:#90969a;flex:none}.a2a-remote-status i.online{background:#42816c}.a2a-remote-status i.busy{background:#bd8826}
.a2a-remote-rail{display:inline-flex;align-items:center;justify-content:center;height:36px;width:36px;padding:0}.a2a-remote-agents button:disabled{opacity:.5;cursor:wait}.a2a-remote-agents button:focus-visible,.a2a-remote-rail:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#52796f);outline-offset:1px}
@media(prefers-reduced-motion:reduce){.a2a-remote-chevron{transition:none}}
`;
