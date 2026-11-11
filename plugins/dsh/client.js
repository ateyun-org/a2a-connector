// Built by npm run build:client.
window.__ModuleLoader__.load({id:"dsh-a2a-connector",factory(require){const module={exports:{}};const exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/sidebar.jsx
var sidebar_exports = {};
__export(sidebar_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(sidebar_exports);
var import_react = __toESM(require("react"), 1);

// control-contract.js
function codec(parse, typeSymbol, jsonSchema) {
  return { mode: "strict", typeSymbol, jsonSchema, create: () => ({ parse }) };
}
function input(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.agentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.agentId)) throw new Error("\u8BF7\u9009\u62E9\u6709\u6548\u7684\u8FDC\u7A0B Agent\u3002");
  if (value.sessionId !== void 0 && (typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId))) {
    throw new Error("\u8BF7\u9009\u62E9\u6709\u6548\u7684 DSH \u4F1A\u8BDD\u3002");
  }
  if (value.newSession !== void 0 && typeof value.newSession !== "boolean") throw new Error("\u65B0\u5EFA\u804A\u5929\u53C2\u6570\u65E0\u6548\u3002");
  return value;
}
var json = codec((value) => {
  const serialized = JSON.stringify(value);
  if (serialized === void 0) throw new Error("Invalid control response");
  return JSON.parse(serialized);
}, "a2aControl.Json", {});
var selection = codec(input, "a2aControl.Selection", { type: "object", properties: { agentId: { type: "string" }, sessionId: { type: "string" }, newSession: { type: "boolean" } }, required: ["agentId"] });
var controlContract = {
  package: "dsh-a2a-connector",
  descriptors: Object.entries({ targets: null, open: selection }).map(([method, boundary]) => ({
    id: `dsh-a2a-connector:a2aControl/${method}`,
    service: "a2aControl",
    namespace: "a2aControl",
    method,
    invocation: { kind: "direct" },
    parameters: boundary ? [{ name: "input", wire: "input", source: "json", codec: boundary }] : [],
    result: json
  }))
};

// remote-route.js
var REMOTE_AGENT_PROVIDER = "a2a-remote-agent";
var REMOTE_AGENT_MODEL = "direct";

// client/remote-selection.js
var storageKey = "dsh.a2a.remote-agent";
var RemoteSelection = class {
  constructor(ctx, remote, storage) {
    this.ctx = ctx;
    this.remote = remote;
    this.storage = storage;
    let agentId;
    try {
      agentId = storage?.getItem(storageKey) || null;
    } catch {
    }
    this.snapshot = { agentId: agentId || null, sessionId: null, pending: false, error: "" };
    this.listeners = /* @__PURE__ */ new Set();
    this.bindings = /* @__PURE__ */ new Map();
    this.generation = 0;
    this.current = void 0;
    this.targets = /* @__PURE__ */ new Map();
    this.subscribe = (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    this.getSnapshot = () => this.snapshot;
  }
  patch(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.updateBlock();
    for (const listener of this.listeners) listener();
  }
  remember(agentId) {
    try {
      if (agentId) this.storage?.setItem(storageKey, agentId);
      else this.storage?.removeItem(storageKey);
    } catch {
    }
  }
  currentSession() {
    return Object.values(this.ctx.sessions.list.getSnapshot().byId).find((item) => item.retainedBy?.mainView > 0);
  }
  start() {
    const stop = this.ctx.sessions.list.subscribe(() => this.reconcile());
    this.reconcile();
    return () => {
      ++this.generation;
      stop();
      this.releaseBlock();
      this.listeners.clear();
    };
  }
  setTargets(targets) {
    this.discovered = true;
    this.targets = new Map(targets.map((target) => [target.agentId, target]));
    for (const target of targets) {
      for (const id of target.sessionIds || (target.sessionId ? [target.sessionId] : [])) this.bindings.set(id, target.agentId);
    }
    if (this.snapshot.agentId && !targets.some((target) => target.agentId === this.snapshot.agentId)) {
      ++this.generation;
      this.patch({ sessionId: null, pending: false, error: "\u6240\u9009\u8FDC\u7A0B Agent \u5DF2\u4E0D\u53EF\u8BBF\u95EE\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u76EE\u6807\u6216\u8FD4\u56DE\u672C\u5730 DSH\u3002" });
    } else {
      this.reconcile(true);
      this.patch({});
    }
  }
  reconcile(discovered = false) {
    const row = this.currentSession(), id = row?.id;
    const route = row?.projectionValues?.modelSelection?.next;
    const overridden = this.snapshot.agentId && this.snapshot.sessionId === id && route && (route.provider !== REMOTE_AGENT_PROVIDER || route.model !== REMOTE_AGENT_MODEL);
    if (id === this.current && !discovered && !overridden) return;
    const changed = id !== this.current;
    if (changed) {
      ++this.generation;
      this.releaseBlock();
      this.current = id;
      if (id) {
        this.blockStore = this.ctx.conversation.blocks.storeFor(id);
        this.stopBlock = this.blockStore.subscribe(() => this.updateBlock());
      }
    }
    if (!id) {
      this.patch({ sessionId: null, pending: false });
      return;
    }
    if (!changed && this.snapshot.pending) return;
    const bound = this.bindings.get(id);
    if (row.blank === false && !this.discovered) {
      this.updateBlock();
      return;
    }
    if (bound && (!this.snapshot.agentId || changed && row.blank === false)) {
      this.remember(bound);
      this.patch({ agentId: bound, sessionId: id, pending: false, error: "" });
      return;
    }
    if (changed && row.blank === false && !bound) {
      this.remember(null);
      this.patch({ agentId: null, sessionId: null, pending: false, error: "" });
      return;
    }
    if (!this.snapshot.agentId) {
      this.updateBlock();
      return;
    }
    if (this.snapshot.sessionId === id && bound === this.snapshot.agentId && !overridden) {
      this.updateBlock();
      return;
    }
    void this.select(this.snapshot.agentId);
  }
  newChat(agentId = this.snapshot.agentId, sessionId) {
    if (!agentId) return;
    return this.select(agentId, { newSession: true, sessionId });
  }
  async select(agentId, options = {}) {
    const version = ++this.generation, current = options.sessionId || this.currentSession()?.id;
    const signal = this.ctx.layout.beginNavigation();
    this.remember(agentId);
    this.patch({ agentId, sessionId: null, pending: true, error: "" });
    try {
      const result = await this.remote.open({ agentId, ...current ? { sessionId: current } : {}, ...options.newSession ? { newSession: true } : {} });
      if (!result.ok) throw new Error(result.error?.message || "\u8FDC\u7A0B\u4F1A\u8BDD\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002");
      if (version !== this.generation || signal.aborted) return;
      const opened = result.value;
      this.bindings.set(opened.sessionId, agentId);
      await this.ctx.sessions.refresh();
      if (version !== this.generation || signal.aborted) return;
      this.patch({ sessionId: opened.sessionId, pending: false });
      this.ctx.uiWorkspace.openSession(opened.sessionId);
    } catch (error) {
      if (version === this.generation) this.patch({ pending: false, error: error.message });
    } finally {
      if (version === this.generation && this.snapshot.pending) this.patch({ pending: false });
    }
  }
  async local() {
    const version = ++this.generation, previous = this.snapshot;
    const signal = this.ctx.layout.beginNavigation(), cwd = this.currentSession()?.cwd;
    this.patch({ pending: true, error: "" });
    try {
      const id = await this.ctx.sessions.create(cwd ? { cwd } : {});
      if (version !== this.generation || signal.aborted) return;
      this.remember(null);
      this.patch({ agentId: null, sessionId: null, pending: false });
      this.ctx.uiWorkspace.openSession(id);
    } catch (error) {
      if (version === this.generation) this.patch({ ...previous, pending: false, error: error.message });
    } finally {
      if (version === this.generation && this.snapshot.pending) this.patch({ pending: false });
    }
  }
  updateBlock() {
    if (!this.blockStore || !this.current) return;
    const value = this.blockStore.getSnapshot();
    const blocked = this.snapshot.agentId && (this.snapshot.pending || this.snapshot.sessionId !== this.current);
    if (blocked && !value) {
      this.ownBlock = { reason: this.snapshot.error || "\u6B63\u5728\u8FDE\u63A5\u6240\u9009\u8FDC\u7A0B Agent\uFF0C\u8BF7\u7A0D\u5019\u2026" };
      this.ctx.conversation.blocks.set(this.current, this.ownBlock);
    } else if (!blocked && this.ownBlock && value === this.ownBlock) {
      this.ctx.conversation.blocks.set(this.current, void 0);
      this.ownBlock = void 0;
    } else if (blocked && value === this.ownBlock && value.reason !== (this.snapshot.error || "\u6B63\u5728\u8FDE\u63A5\u6240\u9009\u8FDC\u7A0B Agent\uFF0C\u8BF7\u7A0D\u5019\u2026")) {
      this.ownBlock = { reason: this.snapshot.error || "\u6B63\u5728\u8FDE\u63A5\u6240\u9009\u8FDC\u7A0B Agent\uFF0C\u8BF7\u7A0D\u5019\u2026" };
      this.ctx.conversation.blocks.set(this.current, this.ownBlock);
    }
  }
  releaseBlock() {
    this.stopBlock?.();
    this.stopBlock = void 0;
    if (this.ownBlock && this.blockStore?.getSnapshot() === this.ownBlock) this.ctx.conversation.blocks.set(this.current, void 0);
    this.blockStore = void 0;
    this.ownBlock = void 0;
  }
};

// client/sidebar.jsx
async function call(remote, method, input2) {
  const result = await (input2 === void 0 ? remote[method]() : remote[method](input2));
  if (!result.ok) throw new Error(result.error?.message || "\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
  return result.value;
}
function RobotIcon() {
  return /* @__PURE__ */ import_react.default.createElement(
    "svg",
    {
      className: "a2a-remote-robot",
      width: "20",
      height: "20",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.7",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false"
    },
    /* @__PURE__ */ import_react.default.createElement("path", { d: "M12 7V3H9M4 12H2v4h2m16-4h2v4h-2" }),
    /* @__PURE__ */ import_react.default.createElement("rect", { x: "4", y: "7", width: "16", height: "14", rx: "4" }),
    /* @__PURE__ */ import_react.default.createElement("path", { d: "M9 12v2m6-2v2m-6 3h6" })
  );
}
function DirectChatStatus({ sessionId, selection: selection2 }) {
  const state = (0, import_react.useSyncExternalStore)(selection2.subscribe, selection2.getSnapshot);
  const active = selection2.current === sessionId ? state.agentId : null;
  const agentId = active || selection2.bindings.get(sessionId);
  if (!agentId) return null;
  const target = selection2.targets.get(agentId);
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "a2a-direct-status", role: "status" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "a2a-direct-info" }, /* @__PURE__ */ import_react.default.createElement(RobotIcon, null), /* @__PURE__ */ import_react.default.createElement("span", null, /* @__PURE__ */ import_react.default.createElement("strong", null, active && state.pending ? "\u6B63\u5728\u8FDE\u63A5" : "\u76F4\u804A", " \xB7 ", target?.name || agentId), /* @__PURE__ */ import_react.default.createElement("small", { title: "\u6D88\u606F\u76F4\u63A5\u53D1\u9001\u7ED9\u8FDC\u7A0B Agent\uFF0C\u65E0\u9700\u9009\u62E9\u4E3B\u63A7\u6A21\u578B" }, "\u6D88\u606F\u76F4\u63A5\u53D1\u9001\u7ED9\u8FDC\u7A0B Agent\uFF0C\u65E0\u9700\u9009\u62E9\u4E3B\u63A7\u6A21\u578B"))), /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      className: "a2a-remote-new",
      disabled: state.pending,
      onClick: () => void selection2.newChat(agentId, sessionId)
    },
    "\u65B0\u5EFA\u804A\u5929"
  ));
}
function RemoteAgents({ remote, selection: selection2, expandSidebar, wide = true, useSessions }) {
  const [expanded, setExpanded] = (0, import_react.useState)(true), [targets, setTargets] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)("");
  const selected = (0, import_react.useSyncExternalStore)(selection2.subscribe, selection2.getSnapshot);
  const sessions = useSessions((state) => state.byId);
  const history = Object.values(sessions).filter((row) => selection2.bindings.get(row.id) === selected.agentId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  (0, import_react.useEffect)(() => {
    let gone = false, loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const list = await call(remote, "targets");
        if (!gone) {
          selection2.setTargets(list);
          setTargets(list);
          setError("");
        }
      } catch (error2) {
        if (!gone) setError(error2.message);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1e4);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [remote, selection2]);
  if (!wide) return /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      className: "a2a-remote-rail",
      "aria-label": "\u5C55\u5F00\u8FDC\u7A0B Agents",
      title: "\u8FDC\u7A0B Agents",
      onClick: () => {
        setExpanded(true);
        expandSidebar();
      }
    },
    /* @__PURE__ */ import_react.default.createElement(RobotIcon, null)
  );
  return /* @__PURE__ */ import_react.default.createElement("section", { className: "a2a-remote-agents", "aria-label": "\u53EF\u63A7\u5236\u7684\u8FDC\u7A0B Agent" }, /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      className: "a2a-remote-heading",
      "aria-expanded": expanded,
      "aria-controls": "a2a-remote-list",
      onClick: () => setExpanded((value) => !value)
    },
    /* @__PURE__ */ import_react.default.createElement(RobotIcon, null),
    /* @__PURE__ */ import_react.default.createElement("span", null, "\u8FDC\u7A0B Agents"),
    /* @__PURE__ */ import_react.default.createElement("small", null, targets?.length ?? "\u2026"),
    /* @__PURE__ */ import_react.default.createElement(
      "svg",
      {
        className: "a2a-remote-chevron",
        width: "14",
        height: "14",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.8",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false"
      },
      /* @__PURE__ */ import_react.default.createElement("path", { d: "m9 6 6 6-6 6" })
    )
  ), expanded && /* @__PURE__ */ import_react.default.createElement("div", { id: "a2a-remote-list", className: "a2a-remote-list" }, (error || selected.error) && /* @__PURE__ */ import_react.default.createElement("p", { role: "alert" }, error || selected.error), selected.agentId && /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      className: "a2a-remote-local",
      disabled: selected.pending,
      onClick: () => void selection2.local()
    },
    "\u8FD4\u56DE\u672C\u5730 DSH"
  ), targets === null && !error && /* @__PURE__ */ import_react.default.createElement("p", { role: "status" }, "\u6B63\u5728\u8BFB\u53D6\u6388\u6743\u5217\u8868\u2026"), targets?.length === 0 && /* @__PURE__ */ import_react.default.createElement("p", null, "\u6682\u65E0\u53EF\u63A7\u5236\u7684 Agent\uFF0C\u8BF7\u7531\u7BA1\u7406\u5458\u914D\u7F6E\u8C03\u7528\u6388\u6743\u3002"), targets?.map((target) => /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, { key: target.agentId }, /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      className: "a2a-remote-row",
      "aria-current": selected.agentId === target.agentId ? "page" : void 0,
      disabled: selected.pending && selected.agentId === target.agentId,
      onClick: () => void selection2.select(target.agentId)
    },
    /* @__PURE__ */ import_react.default.createElement("span", { className: "a2a-remote-name" }, target.name || target.agentId),
    /* @__PURE__ */ import_react.default.createElement("span", { className: "a2a-remote-status" }, /* @__PURE__ */ import_react.default.createElement("i", { className: !target.online ? "offline" : target.busy ? "busy" : "online" }), selected.pending && selected.agentId === target.agentId ? "\u6B63\u5728\u6253\u5F00\u2026" : !target.online ? "\u79BB\u7EBF" : target.connectionStatus === "hosted_ready" ? target.busy ? "\u63A5\u6536\u7AEF\u5C31\u7EEA \xB7 \u5FD9\u788C" : "\u63A5\u6536\u7AEF\u5C31\u7EEA \xB7 \u7A7A\u95F2" : target.busy ? "\u5728\u7EBF \xB7 \u5FD9\u788C" : "\u5728\u7EBF \xB7 \u7A7A\u95F2", target.queuedTasks > 0 && ` \xB7 \u6392\u961F ${target.queuedTasks}`)
  ), selected.agentId === target.agentId && /* @__PURE__ */ import_react.default.createElement("div", { className: "a2a-remote-chats" }, /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      className: "a2a-remote-new",
      disabled: selected.pending,
      onClick: () => void selection2.newChat(target.agentId)
    },
    "\u65B0\u5EFA\u804A\u5929"
  ), /* @__PURE__ */ import_react.default.createElement("details", { className: "a2a-remote-history" }, /* @__PURE__ */ import_react.default.createElement("summary", null, "\u804A\u5929\u8BB0\u5F55\uFF08", history.length, "\uFF09"), history.map((row) => /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      key: row.id,
      className: "a2a-remote-history-row",
      "data-session-id": row.id,
      "aria-current": selected.sessionId === row.id ? "page" : void 0,
      disabled: selected.pending,
      onClick: () => void selection2.select(target.agentId, { sessionId: row.id })
    },
    /* @__PURE__ */ import_react.default.createElement("span", null, row.title || row.displayTitle || "\u804A\u5929\u8BB0\u5F55"),
    /* @__PURE__ */ import_react.default.createElement("small", null, row.updatedAt ? new Date(row.updatedAt).toLocaleString(void 0, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }) : "\u65B0\u804A\u5929", row.running ? " \xB7 \u8FD0\u884C\u4E2D" : "")
  ))))))));
}
var inject = ["slots", "remote", "sessions", "uiWorkspace", "layout", "conversation"];
function apply(ctx) {
  ctx.effect(() => ctx.remote.$mount(controlContract));
  ctx.inject(["remote.a2aControl"], (scope) => {
    let storage;
    try {
      storage = window.sessionStorage;
    } catch {
    }
    const selection2 = new RemoteSelection(scope, scope.remote.a2aControl, storage);
    scope.effect(() => selection2.start());
    scope.slots.inject("sidebar.footer.action", () => scope.slots.register({
      name: "sidebar.footer.action",
      id: "a2a-remote-agents",
      order: -10,
      inject: () => ({
        remote: scope.remote.a2aControl,
        selection: selection2,
        expandSidebar: () => scope.layout.toggleSidebar()
      })
    }, RemoteAgents));
    scope.slots.inject("conversation.input.dock", () => scope.slots.register({
      name: "conversation.input.dock",
      id: "a2a-direct-chat",
      order: -20,
      inject: () => ({ selection: selection2 })
    }, DirectChatStatus));
    scope.effect(() => {
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-a2a-connector";
      style.textContent = css;
      document.head.append(style);
      return () => style.remove();
    });
  });
}
var css = `
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

return module.exports;}});
