import React, { useEffect, useRef, useState } from 'react';
import { controlContract } from '../control-contract.js';

const states = { idle: '开始聊天', sending: '正在发送', queued: '排队中', unknown: '结果待确认',
  submitted: '任务已受理', working: '执行中', completed: '已完成', failed: '任务失败', canceled: '已取消',
  rejected: '已拒绝', input_required: '等待你的回复', auth_required: '等待授权', unspecified: '查询中' };
const waiting = new Set(['sending', 'queued', 'unknown', 'submitted', 'working', 'unspecified']);

async function call(remote, method, input) {
  const result = await (input === undefined ? remote[method]() : remote[method](input));
  if (!result.ok) throw new Error(result.error?.message || '请求失败，请稍后重试。');
  return result.value;
}

function ControlPage({ remote }) {
  const [targets, setTargets] = useState(null), [selected, select] = useState('');
  const [chat, setChat] = useState(null), [error, setError] = useState(''), [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false), [drafts, setDrafts] = useState({});
  const generation = useRef(0), messageID = useRef(null), bottom = useRef(null);
  const target = targets?.find(target => target.agentId === selected);

  useEffect(() => {
    let gone = false, loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true; setRefreshing(true);
      try {
        const value = await call(remote, 'targets');
        if (!gone) { setTargets(value); setListError(''); select(id => value.some(target => target.agentId === id) ? id : value[0]?.agentId || ''); }
      } catch (error) { if (!gone) setListError(error.message); }
      finally { loading = false; if (!gone) setRefreshing(false); }
    };
    void refresh(); const timer = setInterval(refresh, 10000);
    return () => { gone = true; clearInterval(timer); };
  }, [remote]);

  useEffect(() => {
    const version = ++generation.current;
    setChat(null); setError(''); setBusy(false); messageID.current = null;
    if (!selected) return;
    let loading = false, gone = false;
    const refresh = async () => {
      if (loading) return; loading = true;
      try {
        const value = await call(remote, 'poll', { agentId: selected });
        if (!gone && version === generation.current) { setChat(value); setError(''); if (!waiting.has(value.state)) messageID.current = null; }
      } catch (error) { if (!gone && version === generation.current) setError(error.message); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(refresh, 3000);
    return () => { gone = true; clearInterval(timer); };
  }, [selected, remote]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [chat?.messages?.length]);

  async function send(event) {
    event.preventDefault();
    const text = drafts[selected]?.trim();
    if (!text || busy || waiting.has(chat?.state) || listError || !target?.online) return;
    const version = generation.current, agentId = selected;
    setBusy(true); setError('');
    // A lost RPC reply keeps this exact identity for recovery, never a retry.
    messageID.current ||= crypto.randomUUID();
    try {
      const value = await call(remote, 'send', { agentId, text, messageId: messageID.current });
      if (version === generation.current) { setChat(value); setDrafts(current => ({ ...current, [agentId]: '' })); messageID.current = null; }
    } catch (error) {
      if (version === generation.current) setError(`${error.message} 请先查询原请求。`);
    } finally { if (version === generation.current) setBusy(false); }
  }

  async function refresh() {
    const version = generation.current;
    try { const value = await call(remote, 'poll', { agentId: selected }); if (version === generation.current) { setChat(value); setError(''); } }
    catch (error) { if (version === generation.current) setError(error.message); }
  }

  return <div className="a2a-control">
    <aside className="a2a-agents" aria-label="可控制的远程 Agent">
      <header><strong>远程 Agents</strong><small>{refreshing ? '同步中…' : `${targets?.length || 0} 个可控制`}</small></header>
      {listError && <p role="alert" className="a2a-error">{listError}</p>}
      {targets === null && !listError && <p className="a2a-empty">正在读取授权列表…</p>}
      {targets?.length === 0 && <p className="a2a-empty">暂无可控制的 Agent，请由管理员在 Relay 配置调用授权。</p>}
      <nav>{targets?.map(item => <button type="button" key={item.agentId} aria-pressed={selected === item.agentId}
        onClick={() => select(item.agentId)} className={selected === item.agentId ? 'a2a-agent selected' : 'a2a-agent'}>
        <span className="a2a-agent-name" title={item.name || item.agentId}>{item.name || item.agentId}</span>
        <span className="a2a-agent-status"><i className={item.online ? (item.busy ? 'busy' : 'online') : 'offline'} />
          {!item.online ? '离线' : item.connectionStatus === 'hosted_ready' ? (item.busy ? '接收端就绪 · 忙碌' : '接收端就绪 · 空闲') : item.busy ? '在线 · 忙碌' : '在线 · 空闲'}
          {item.queuedTasks > 0 && ` · 排队 ${item.queuedTasks}`}</span>
        <small>{item.activeTasks || 0} / {item.maxConcurrency || 1} 执行中</small>
      </button>)}</nav>
    </aside>
    <section className="a2a-chat" aria-label="远程 Agent 独立聊天">
      <header className="a2a-chat-header"><div><strong>{target?.name || '远程 Agent 聊天'}</strong>
        <p>{selected ? states[chat?.state] || '读取会话中…' : '在左侧选择一个 Agent，开始独立聊天。'}</p></div>
        {selected && <button type="button" onClick={refresh}>查询原请求</button>}</header>
      <div className="a2a-messages" role="log" aria-live="polite">
        {!selected && <div className="a2a-empty">授权范围、在线状态和执行负载由 Relay 定期同步。</div>}
        {selected && chat?.messages?.length === 0 && <div className="a2a-empty">你与此 Agent 的独立会话。消息会按远端并发上限排队。</div>}
        {chat?.messages?.map((message, index) => <article key={`${message.messageId}:${message.role}:${index}`} className={`a2a-message ${message.role}`}>
          <small>{message.role === 'user' ? '你' : target?.name || 'Agent'}</small><div>{message.text}</div></article>)}
        {waiting.has(chat?.state) && <p className="a2a-progress" role="status">{states[chat.state]}…</p>}
        <div ref={bottom} />
      </div>
      {(error || chat?.error) && <p role="alert" className="a2a-error">{error || chat.error}</p>}
      <form onSubmit={send} className="a2a-composer">
        <label htmlFor="a2a-message">发送给 {target?.name || '远程 Agent'}</label>
        <textarea id="a2a-message" rows="3" maxLength="32000" value={drafts[selected] || ''}
          onChange={event => { const value = event.target.value; setDrafts(current => ({ ...current, [selected]: value })); }}
          disabled={!selected || busy || waiting.has(chat?.state)} placeholder="输入消息…" />
        <div><small>{target && !target.online ? 'Agent 离线，历史会话仍可查看。' : '每个 Agent 保留独立会话和上下文。'}</small>
          <button type="submit" disabled={!selected || busy || !chat || !target?.online || !!listError || waiting.has(chat?.state) || !drafts[selected]?.trim()}>{busy ? '正在发送…' : '发送消息'}</button></div>
      </form>
    </section>
  </div>;
}

export const inject = ['slots', 'remote'];
export function apply(ctx) {
  ctx.effect(() => ctx.remote.$mount(controlContract));
  ctx.inject(['remote.a2aControl'], scope => {
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: 'a2a-control',
      inject: () => ({ remote: scope.remote.a2aControl }) }, ControlPage));
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: 'a2a-control', order: -10, label: '远程 Agents' }, () => React.createElement('span', { 'aria-hidden': true }, '◉')));
    scope.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'dsh-a2a-connector'; style.textContent = css; document.head.append(style); return () => style.remove(); });
  });
}

const css = `
.a2a-control{display:grid;grid-template-columns:250px minmax(0,1fr);height:100%;min-height:400px;color:inherit;font:inherit;background:transparent}
.a2a-control *{box-sizing:border-box}.a2a-control button,.a2a-control textarea{font:inherit;color:inherit}
.a2a-control button{cursor:pointer;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;border-radius:8px;padding:8px 12px}
.a2a-control button:disabled{opacity:.45;cursor:default}.a2a-control button:focus-visible,.a2a-control textarea:focus-visible{outline:2px solid #52796f;outline-offset:2px}
.a2a-agents{border-right:1px solid color-mix(in srgb,currentColor 13%,transparent);overflow:auto;padding:20px 12px;min-width:0}
.a2a-agents header{display:grid;gap:8px;margin:0 8px 20px}.a2a-control small{opacity:.65;font-size:12px}.a2a-agents nav{display:grid;gap:6px}
.a2a-control .a2a-agent{display:grid;gap:7px;width:100%;text-align:left;border-color:transparent;padding:12px;overflow-wrap:anywhere}
.a2a-control .a2a-agent.selected{background:color-mix(in srgb,#52796f 12%,transparent);border-color:color-mix(in srgb,#52796f 30%,transparent)}
.a2a-agent-name{font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4}.a2a-agent-status{display:flex;align-items:center;gap:6px;font-size:12px}.a2a-agent-status i{height:7px;width:7px;flex-shrink:0;border-radius:100%;background:#90969a}.a2a-agent-status .online{background:#42816c}.a2a-agent-status .busy{background:#bd8826}
.a2a-chat{display:flex;flex-direction:column;min-width:0;min-height:0}.a2a-chat-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 24px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}
.a2a-chat-header>div{min-width:0;overflow-wrap:anywhere}.a2a-chat-header>button{flex-shrink:0;white-space:nowrap}.a2a-chat-header p{margin:6px 0 0;font-size:12px;opacity:.65}.a2a-messages{flex:1;overflow:auto;min-height:180px;padding:24px}.a2a-empty{font-size:13px;opacity:.65;line-height:1.8;padding:16px 8px}
.a2a-message{max-width:90%;margin:0 0 18px;padding:12px 16px;border-radius:12px;background:color-mix(in srgb,currentColor 5%,transparent);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;font-size:14px}.a2a-message.user{margin-left:auto;background:color-mix(in srgb,#52796f 12%,transparent)}.a2a-message small{display:block;margin-bottom:5px}
.a2a-progress{font-size:13px;opacity:.65}.a2a-error{font-size:12px;color:#c04e42;line-height:1.7;padding:8px 16px;overflow-wrap:anywhere;margin:0}
.a2a-composer{padding:16px 24px 24px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}.a2a-composer label{font-size:12px;display:block;margin-bottom:8px;opacity:.7}.a2a-composer textarea{width:100%;resize:vertical;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;padding:10px 12px;background:transparent}.a2a-composer>div{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px}.a2a-composer button{background:#365d50;color:white;white-space:nowrap}
@media(max-width:600px){.a2a-control{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.a2a-agents{max-height:200px;border-right:0;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);padding:12px}.a2a-agents header{margin-bottom:8px}.a2a-agents nav{display:flex;overflow:auto}.a2a-control .a2a-agent{min-width:160px;width:160px;flex-shrink:0}.a2a-chat-header,.a2a-composer{padding:14px}.a2a-messages{padding:14px}.a2a-composer>div{align-items:flex-end}.a2a-composer small{font-size:11px}}
`;
