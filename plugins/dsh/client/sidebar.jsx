import React, { useEffect, useRef, useState } from 'react';
import { controlContract } from '../control-contract.js';

async function call(remote, method, input) {
  const result = await (input === undefined ? remote[method]() : remote[method](input));
  if (!result.ok) throw new Error(result.error?.message || '请求失败，请稍后重试。');
  return result.value;
}

function RemoteAgents({ remote, openSession, expandSidebar, wide = true, useSessions }) {
  const [expanded, setExpanded] = useState(true), [targets, setTargets] = useState(null);
  const [error, setError] = useState(''), [opening, setOpening] = useState('');
  const generation = useRef(0);
  const current = useSessions(state => Object.values(state.byId).find(item => item.retainedBy?.mainView > 0)?.id);
  useEffect(() => {
    let gone = false, loading = false;
    const refresh = async () => {
      if (loading) return; loading = true;
      try { const list = await call(remote, 'targets'); if (!gone) { setTargets(list); setError(''); } }
      catch (error) { if (!gone) setError(error.message); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { gone = true; ++generation.current; clearInterval(timer); };
  }, [remote]);

  async function open(agentId) {
    const version = ++generation.current;
    setOpening(agentId); setError('');
    try {
      const value = await openSession(agentId);
      if (value && version === generation.current) setTargets(items => items?.map(item => item.agentId === agentId ? { ...item, sessionId: value.sessionId } : item));
    } catch (error) { if (version === generation.current) setError(error.message); }
    finally { if (version === generation.current) setOpening(''); }
  }

  if (!wide) return <button type="button" className="a2a-remote-rail" aria-label="展开远程 Agents" title="远程 Agents"
    onClick={() => { setExpanded(true); expandSidebar(); }}>◉</button>;
  return <section className="a2a-remote-agents" aria-label="可控制的远程 Agent">
    <button type="button" className="a2a-remote-heading" aria-expanded={expanded} aria-controls="a2a-remote-list"
      onClick={() => setExpanded(value => !value)}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span>远程 Agents</span><small>{targets?.length ?? '…'}</small></button>
    {expanded && <div id="a2a-remote-list" className="a2a-remote-list">
      {error && <p role="alert">{error}</p>}
      {targets === null && !error && <p role="status">正在读取授权列表…</p>}
      {targets?.length === 0 && <p>暂无可控制的 Agent，请由管理员配置调用授权。</p>}
      {targets?.map(target => <button type="button" key={target.agentId} className="a2a-remote-row"
        aria-current={target.sessionId && target.sessionId === current ? 'page' : undefined} disabled={opening === target.agentId}
        onClick={() => void open(target.agentId)}>
        <span className="a2a-remote-name">{target.name || target.agentId}</span>
        <span className="a2a-remote-status"><i className={!target.online ? 'offline' : target.busy ? 'busy' : 'online'} />
          {opening === target.agentId ? '正在打开…' : !target.online ? '离线' : target.connectionStatus === 'hosted_ready'
            ? (target.busy ? '接收端就绪 · 忙碌' : '接收端就绪 · 空闲') : target.busy ? '在线 · 忙碌' : '在线 · 空闲'}
          {target.queuedTasks > 0 && ` · 排队 ${target.queuedTasks}`}</span>
      </button>)}
    </div>}
  </section>;
}

export const inject = ['slots', 'remote', 'sessions', 'uiWorkspace', 'layout'];
export function apply(ctx) {
  ctx.effect(() => ctx.remote.$mount(controlContract));
  ctx.inject(['remote.a2aControl'], scope => {
    scope.slots.inject('sidebar.footer.action', () => scope.slots.register({ name: 'sidebar.footer.action', id: 'a2a-remote-agents', order: -10,
      inject: () => ({ remote: scope.remote.a2aControl,
        expandSidebar: () => scope.layout.toggleSidebar(),
        openSession: async agentId => {
          const signal = scope.layout.beginNavigation();
          const opened = await call(scope.remote.a2aControl, 'open', { agentId });
          await scope.sessions.refresh();
          if (signal.aborted) return undefined;
          scope.uiWorkspace.openSession(opened.sessionId);
          return opened;
        } }) }, RemoteAgents));
    scope.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'dsh-a2a-connector'; style.textContent = css; document.head.append(style); return () => style.remove(); });
  });
}

const css = `
.a2a-remote-agents{box-sizing:border-box;flex:1;min-width:0;width:100%;color:var(--dsw-alias-label-primary,inherit);font:inherit;padding:4px var(--dsh-sidebar-inline-padding,8px)}
.a2a-remote-agents button,.a2a-remote-rail{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer;border-radius:6px}
.a2a-remote-heading{display:flex;align-items:center;gap:6px;width:100%;height:32px;padding:0 8px;text-align:left;font-size:13px!important}
.a2a-remote-heading small{margin-left:auto;opacity:.6}.a2a-remote-list{max-height:min(35vh,300px);overflow:auto;display:grid;gap:2px}
.a2a-remote-list p{font-size:12px;line-height:1.6;padding:8px;margin:0;overflow-wrap:anywhere;opacity:.7}.a2a-remote-list [role=alert]{color:var(--dsw-alias-status-error,#b74b42)}
.a2a-remote-row{display:grid;gap:4px;width:100%;padding:8px 12px 8px 26px;text-align:left;min-width:0}
.a2a-remote-row:hover,.a2a-remote-heading:hover{background:var(--dsw-alias-interactive-bg-hover,#8881)}
.a2a-remote-row[aria-current=page]{background:var(--dsw-alias-interactive-bg-selected,#52796f22)}
.a2a-remote-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.a2a-remote-status{font-size:11px;display:flex;align-items:center;gap:5px;opacity:.7;flex-wrap:wrap}
.a2a-remote-status i{height:6px;width:6px;border-radius:50%;background:#90969a;flex:none}.a2a-remote-status i.online{background:#42816c}.a2a-remote-status i.busy{background:#bd8826}
.a2a-remote-rail{height:36px;width:36px}.a2a-remote-agents button:disabled{opacity:.5;cursor:wait}.a2a-remote-agents button:focus-visible,.a2a-remote-rail:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#52796f);outline-offset:1px}
`;
