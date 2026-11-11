import React, { useId, useLayoutEffect, useEffect, useRef, useState } from 'react';

function shortDate(value) {
  if (!value) return '新聊天';
  const date = new Date(value), today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, today ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: '2-digit', day: '2-digit' });
}

/** Native top-layer popover: history never adds rows to the Agent list. */
export function HistoryMenu({ agentId, name, rows, currentId, pending, onSelect }) {
  const id = useId(), trigger = useRef(null), panel = useRef(null), focusOnOpen = useRef(false);
  const [open, setOpen] = useState(false);
  function close(restoreFocus = false) {
    if (panel.current?.matches(':popover-open')) panel.current.hidePopover();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  useEffect(() => {
    const node = panel.current;
    const toggle = event => setOpen(event.newState === 'open');
    const resize = () => close();
    node.addEventListener('toggle', toggle);
    window.addEventListener('resize', resize);
    return () => { node.removeEventListener('toggle', toggle); window.removeEventListener('resize', resize); };
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const node = panel.current, anchor = trigger.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    node.style.width = `${width}px`;
    const height = node.getBoundingClientRect().height;
    node.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
    node.style.top = `${anchor.bottom + 8 + height <= window.innerHeight - 12 ? anchor.bottom + 8 : Math.max(12, anchor.top - height - 8)}px`;
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      (node.querySelector('[data-session-id][aria-current=page]') || node.querySelector('[data-session-id]') || node).focus();
    }
  }, [open, rows]);
  function keyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...panel.current.querySelectorAll('[data-session-id]:not([disabled])')];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (at + 1) % items.length : (at < 0 ? items.length - 1 : (at + items.length - 1) % items.length);
    items[next].focus();
  }
  return <>
    <button ref={trigger} type="button" className="a2a-remote-history-trigger" aria-label="聊天记录"
      title={agentId ? `${name} 的聊天记录` : '选择 Agent 后查看聊天记录'} disabled={!agentId || pending}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => {
        if (panel.current.matches(':popover-open')) close();
        else { focusOnOpen.current = true; panel.current.showPopover(); setOpen(true); }
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M3 11a9 9 0 1 1 2.8 7M3 4v7h7m2-5v6l4 2" />
      </svg>
    </button>
    <div ref={panel} id={id} popover="auto" className="a2a-remote-history-menu" role="dialog" aria-label={`${name} 的聊天记录`}
      tabIndex={-1} onKeyDown={keyDown} onBlur={event => {
        if (event.relatedTarget && event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)) close();
      }}>
      <div className="a2a-remote-history-header"><strong title={name}>{name} · 聊天记录</strong><small>{rows.length}</small>
        <button type="button" aria-label="关闭聊天记录" onClick={() => close(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="a2a-remote-history-entries">
        {open && rows.map(row => <button type="button" key={row.id} className="a2a-remote-history-row" data-session-id={row.id}
          aria-current={currentId === row.id ? 'page' : undefined} disabled={pending}
          title={`${row.title || row.displayTitle || '聊天记录'}${row.updatedAt ? ` · ${new Date(row.updatedAt).toLocaleString()}` : ''}`}
          onClick={() => { close(true); void onSelect(row.id); }}>
          <span className="a2a-remote-history-check" aria-hidden="true">{currentId === row.id && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4 10-10" /></svg>}</span>
          <span className="a2a-remote-history-title">{row.title || row.displayTitle || '聊天记录'}</span>
          {row.running && <i className="a2a-remote-history-running" aria-label="运行中" title="运行中" />}
          <time>{shortDate(row.updatedAt)}</time>
        </button>)}
        {open && rows.length === 0 && <p>暂无聊天记录</p>}
      </div>
    </div>
  </>;
}
