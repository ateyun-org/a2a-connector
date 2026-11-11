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
  return value;
}
var json = codec((value) => {
  const serialized = JSON.stringify(value);
  if (serialized === void 0) throw new Error("Invalid control response");
  return JSON.parse(serialized);
}, "a2aControl.Json", {});
var selection = codec(input, "a2aControl.Selection", { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] });
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

// client/sidebar.jsx
async function call(remote, method, input2) {
  const result = await (input2 === void 0 ? remote[method]() : remote[method](input2));
  if (!result.ok) throw new Error(result.error?.message || "\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
  return result.value;
}
function RemoteAgents({ remote, openSession, expandSidebar, wide = true, useSessions }) {
  const [expanded, setExpanded] = (0, import_react.useState)(true), [targets, setTargets] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(""), [opening, setOpening] = (0, import_react.useState)("");
  const generation = (0, import_react.useRef)(0);
  const current = useSessions((state) => Object.values(state.byId).find((item) => item.retainedBy?.mainView > 0)?.id);
  (0, import_react.useEffect)(() => {
    let gone = false, loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const list = await call(remote, "targets");
        if (!gone) {
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
      ++generation.current;
      clearInterval(timer);
    };
  }, [remote]);
  async function open(agentId) {
    const version = ++generation.current;
    setOpening(agentId);
    setError("");
    try {
      const value = await openSession(agentId);
      if (value && version === generation.current) setTargets((items) => items?.map((item) => item.agentId === agentId ? { ...item, sessionId: value.sessionId } : item));
    } catch (error2) {
      if (version === generation.current) setError(error2.message);
    } finally {
      if (version === generation.current) setOpening("");
    }
  }
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
    "\u25C9"
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
    /* @__PURE__ */ import_react.default.createElement("span", { "aria-hidden": "true" }, expanded ? "\u25BE" : "\u25B8"),
    /* @__PURE__ */ import_react.default.createElement("span", null, "\u8FDC\u7A0B Agents"),
    /* @__PURE__ */ import_react.default.createElement("small", null, targets?.length ?? "\u2026")
  ), expanded && /* @__PURE__ */ import_react.default.createElement("div", { id: "a2a-remote-list", className: "a2a-remote-list" }, error && /* @__PURE__ */ import_react.default.createElement("p", { role: "alert" }, error), targets === null && !error && /* @__PURE__ */ import_react.default.createElement("p", { role: "status" }, "\u6B63\u5728\u8BFB\u53D6\u6388\u6743\u5217\u8868\u2026"), targets?.length === 0 && /* @__PURE__ */ import_react.default.createElement("p", null, "\u6682\u65E0\u53EF\u63A7\u5236\u7684 Agent\uFF0C\u8BF7\u7531\u7BA1\u7406\u5458\u914D\u7F6E\u8C03\u7528\u6388\u6743\u3002"), targets?.map((target) => /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      key: target.agentId,
      className: "a2a-remote-row",
      "aria-current": target.sessionId && target.sessionId === current ? "page" : void 0,
      disabled: opening === target.agentId,
      onClick: () => void open(target.agentId)
    },
    /* @__PURE__ */ import_react.default.createElement("span", { className: "a2a-remote-name" }, target.name || target.agentId),
    /* @__PURE__ */ import_react.default.createElement("span", { className: "a2a-remote-status" }, /* @__PURE__ */ import_react.default.createElement("i", { className: !target.online ? "offline" : target.busy ? "busy" : "online" }), opening === target.agentId ? "\u6B63\u5728\u6253\u5F00\u2026" : !target.online ? "\u79BB\u7EBF" : target.connectionStatus === "hosted_ready" ? target.busy ? "\u63A5\u6536\u7AEF\u5C31\u7EEA \xB7 \u5FD9\u788C" : "\u63A5\u6536\u7AEF\u5C31\u7EEA \xB7 \u7A7A\u95F2" : target.busy ? "\u5728\u7EBF \xB7 \u5FD9\u788C" : "\u5728\u7EBF \xB7 \u7A7A\u95F2", target.queuedTasks > 0 && ` \xB7 \u6392\u961F ${target.queuedTasks}`)
  ))));
}
var inject = ["slots", "remote", "sessions", "uiWorkspace", "layout"];
function apply(ctx) {
  ctx.effect(() => ctx.remote.$mount(controlContract));
  ctx.inject(["remote.a2aControl"], (scope) => {
    scope.slots.inject("sidebar.footer.action", () => scope.slots.register({
      name: "sidebar.footer.action",
      id: "a2a-remote-agents",
      order: -10,
      inject: () => ({
        remote: scope.remote.a2aControl,
        expandSidebar: () => scope.layout.toggleSidebar(),
        openSession: async (agentId) => {
          const signal = scope.layout.beginNavigation();
          const opened = await call(scope.remote.a2aControl, "open", { agentId });
          await scope.sessions.refresh();
          if (signal.aborted) return void 0;
          scope.uiWorkspace.openSession(opened.sessionId);
          return opened;
        }
      })
    }, RemoteAgents));
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

return module.exports;}});
