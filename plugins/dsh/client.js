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

// client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
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
var send = codec((value) => {
  input(value);
  if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 32e3 || typeof value.messageId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.messageId)) throw new Error("\u6D88\u606F\u987B\u4E3A 1 \u81F3 32000 \u4E2A\u5B57\u7B26\uFF0C\u5E76\u643A\u5E26\u56FA\u5B9A\u6D88\u606F\u7F16\u53F7\u3002");
  return { agentId: value.agentId, text: value.text, messageId: value.messageId };
}, "a2aControl.Send", { type: "object", properties: { agentId: { type: "string" }, text: { type: "string" }, messageId: { type: "string" } }, required: ["agentId", "text", "messageId"] });
var controlContract = {
  package: "dsh-a2a-connector",
  descriptors: Object.entries({ targets: null, chat: selection, send, poll: selection }).map(([method, boundary]) => ({
    id: `dsh-a2a-connector:a2aControl/${method}`,
    service: "a2aControl",
    namespace: "a2aControl",
    method,
    invocation: { kind: "direct" },
    parameters: boundary ? [{ name: "input", wire: "input", source: "json", codec: boundary }] : [],
    result: json
  }))
};

// client/index.jsx
var states = {
  idle: "\u5F00\u59CB\u804A\u5929",
  sending: "\u6B63\u5728\u53D1\u9001",
  queued: "\u6392\u961F\u4E2D",
  unknown: "\u7ED3\u679C\u5F85\u786E\u8BA4",
  submitted: "\u4EFB\u52A1\u5DF2\u53D7\u7406",
  working: "\u6267\u884C\u4E2D",
  completed: "\u5DF2\u5B8C\u6210",
  failed: "\u4EFB\u52A1\u5931\u8D25",
  canceled: "\u5DF2\u53D6\u6D88",
  rejected: "\u5DF2\u62D2\u7EDD",
  input_required: "\u7B49\u5F85\u4F60\u7684\u56DE\u590D",
  auth_required: "\u7B49\u5F85\u6388\u6743",
  unspecified: "\u67E5\u8BE2\u4E2D"
};
var waiting = /* @__PURE__ */ new Set(["sending", "queued", "unknown", "submitted", "working", "unspecified"]);
async function call(remote, method, input2) {
  const result = await (input2 === void 0 ? remote[method]() : remote[method](input2));
  if (!result.ok) throw new Error(result.error?.message || "\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
  return result.value;
}
function ControlPage({ remote }) {
  const [targets, setTargets] = (0, import_react.useState)(null), [selected, select] = (0, import_react.useState)("");
  const [chat, setChat] = (0, import_react.useState)(null), [error, setError] = (0, import_react.useState)(""), [listError, setListError] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false), [refreshing, setRefreshing] = (0, import_react.useState)(false), [drafts, setDrafts] = (0, import_react.useState)({});
  const generation = (0, import_react.useRef)(0), messageID = (0, import_react.useRef)(null), bottom = (0, import_react.useRef)(null);
  const target = targets?.find((target2) => target2.agentId === selected);
  (0, import_react.useEffect)(() => {
    let gone = false, loading = false;
    const refresh2 = async () => {
      if (loading) return;
      loading = true;
      setRefreshing(true);
      try {
        const value = await call(remote, "targets");
        if (!gone) {
          setTargets(value);
          setListError("");
          select((id) => value.some((target2) => target2.agentId === id) ? id : value[0]?.agentId || "");
        }
      } catch (error2) {
        if (!gone) setListError(error2.message);
      } finally {
        loading = false;
        if (!gone) setRefreshing(false);
      }
    };
    void refresh2();
    const timer = setInterval(refresh2, 1e4);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [remote]);
  (0, import_react.useEffect)(() => {
    const version = ++generation.current;
    setChat(null);
    setError("");
    setBusy(false);
    messageID.current = null;
    if (!selected) return;
    let loading = false, gone = false;
    const refresh2 = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await call(remote, "poll", { agentId: selected });
        if (!gone && version === generation.current) {
          setChat(value);
          setError("");
          if (!waiting.has(value.state)) messageID.current = null;
        }
      } catch (error2) {
        if (!gone && version === generation.current) setError(error2.message);
      } finally {
        loading = false;
      }
    };
    void refresh2();
    const timer = setInterval(refresh2, 3e3);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [selected, remote]);
  (0, import_react.useEffect)(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat?.messages?.length]);
  async function send2(event) {
    event.preventDefault();
    const text = drafts[selected]?.trim();
    if (!text || busy || waiting.has(chat?.state) || listError || !target?.online) return;
    const version = generation.current, agentId = selected;
    setBusy(true);
    setError("");
    messageID.current ||= crypto.randomUUID();
    try {
      const value = await call(remote, "send", { agentId, text, messageId: messageID.current });
      if (version === generation.current) {
        setChat(value);
        setDrafts((current) => ({ ...current, [agentId]: "" }));
        messageID.current = null;
      }
    } catch (error2) {
      if (version === generation.current) setError(`${error2.message} \u8BF7\u5148\u67E5\u8BE2\u539F\u8BF7\u6C42\u3002`);
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  async function refresh() {
    const version = generation.current;
    try {
      const value = await call(remote, "poll", { agentId: selected });
      if (version === generation.current) {
        setChat(value);
        setError("");
      }
    } catch (error2) {
      if (version === generation.current) setError(error2.message);
    }
  }
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "a2a-control" }, /* @__PURE__ */ import_react.default.createElement("aside", { className: "a2a-agents", "aria-label": "\u53EF\u63A7\u5236\u7684\u8FDC\u7A0B Agent" }, /* @__PURE__ */ import_react.default.createElement("header", null, /* @__PURE__ */ import_react.default.createElement("strong", null, "\u8FDC\u7A0B Agents"), /* @__PURE__ */ import_react.default.createElement("small", null, refreshing ? "\u540C\u6B65\u4E2D\u2026" : `${targets?.length || 0} \u4E2A\u53EF\u63A7\u5236`)), listError && /* @__PURE__ */ import_react.default.createElement("p", { role: "alert", className: "a2a-error" }, listError), targets === null && !listError && /* @__PURE__ */ import_react.default.createElement("p", { className: "a2a-empty" }, "\u6B63\u5728\u8BFB\u53D6\u6388\u6743\u5217\u8868\u2026"), targets?.length === 0 && /* @__PURE__ */ import_react.default.createElement("p", { className: "a2a-empty" }, "\u6682\u65E0\u53EF\u63A7\u5236\u7684 Agent\uFF0C\u8BF7\u7531\u7BA1\u7406\u5458\u5728 Relay \u914D\u7F6E\u8C03\u7528\u6388\u6743\u3002"), /* @__PURE__ */ import_react.default.createElement("nav", null, targets?.map((item) => /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      key: item.agentId,
      "aria-pressed": selected === item.agentId,
      onClick: () => select(item.agentId),
      className: selected === item.agentId ? "a2a-agent selected" : "a2a-agent"
    },
    /* @__PURE__ */ import_react.default.createElement("span", { className: "a2a-agent-name", title: item.name || item.agentId }, item.name || item.agentId),
    /* @__PURE__ */ import_react.default.createElement("span", { className: "a2a-agent-status" }, /* @__PURE__ */ import_react.default.createElement("i", { className: item.online ? item.busy ? "busy" : "online" : "offline" }), !item.online ? "\u79BB\u7EBF" : item.connectionStatus === "hosted_ready" ? item.busy ? "\u63A5\u6536\u7AEF\u5C31\u7EEA \xB7 \u5FD9\u788C" : "\u63A5\u6536\u7AEF\u5C31\u7EEA \xB7 \u7A7A\u95F2" : item.busy ? "\u5728\u7EBF \xB7 \u5FD9\u788C" : "\u5728\u7EBF \xB7 \u7A7A\u95F2", item.queuedTasks > 0 && ` \xB7 \u6392\u961F ${item.queuedTasks}`),
    /* @__PURE__ */ import_react.default.createElement("small", null, item.activeTasks || 0, " / ", item.maxConcurrency || 1, " \u6267\u884C\u4E2D")
  )))), /* @__PURE__ */ import_react.default.createElement("section", { className: "a2a-chat", "aria-label": "\u8FDC\u7A0B Agent \u72EC\u7ACB\u804A\u5929" }, /* @__PURE__ */ import_react.default.createElement("header", { className: "a2a-chat-header" }, /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("strong", null, target?.name || "\u8FDC\u7A0B Agent \u804A\u5929"), /* @__PURE__ */ import_react.default.createElement("p", null, selected ? states[chat?.state] || "\u8BFB\u53D6\u4F1A\u8BDD\u4E2D\u2026" : "\u5728\u5DE6\u4FA7\u9009\u62E9\u4E00\u4E2A Agent\uFF0C\u5F00\u59CB\u72EC\u7ACB\u804A\u5929\u3002")), selected && /* @__PURE__ */ import_react.default.createElement("button", { type: "button", onClick: refresh }, "\u67E5\u8BE2\u539F\u8BF7\u6C42")), /* @__PURE__ */ import_react.default.createElement("div", { className: "a2a-messages", role: "log", "aria-live": "polite" }, !selected && /* @__PURE__ */ import_react.default.createElement("div", { className: "a2a-empty" }, "\u6388\u6743\u8303\u56F4\u3001\u5728\u7EBF\u72B6\u6001\u548C\u6267\u884C\u8D1F\u8F7D\u7531 Relay \u5B9A\u671F\u540C\u6B65\u3002"), selected && chat?.messages?.length === 0 && /* @__PURE__ */ import_react.default.createElement("div", { className: "a2a-empty" }, "\u4F60\u4E0E\u6B64 Agent \u7684\u72EC\u7ACB\u4F1A\u8BDD\u3002\u6D88\u606F\u4F1A\u6309\u8FDC\u7AEF\u5E76\u53D1\u4E0A\u9650\u6392\u961F\u3002"), chat?.messages?.map((message, index) => /* @__PURE__ */ import_react.default.createElement("article", { key: `${message.messageId}:${message.role}:${index}`, className: `a2a-message ${message.role}` }, /* @__PURE__ */ import_react.default.createElement("small", null, message.role === "user" ? "\u4F60" : target?.name || "Agent"), /* @__PURE__ */ import_react.default.createElement("div", null, message.text))), waiting.has(chat?.state) && /* @__PURE__ */ import_react.default.createElement("p", { className: "a2a-progress", role: "status" }, states[chat.state], "\u2026"), /* @__PURE__ */ import_react.default.createElement("div", { ref: bottom })), (error || chat?.error) && /* @__PURE__ */ import_react.default.createElement("p", { role: "alert", className: "a2a-error" }, error || chat.error), /* @__PURE__ */ import_react.default.createElement("form", { onSubmit: send2, className: "a2a-composer" }, /* @__PURE__ */ import_react.default.createElement("label", { htmlFor: "a2a-message" }, "\u53D1\u9001\u7ED9 ", target?.name || "\u8FDC\u7A0B Agent"), /* @__PURE__ */ import_react.default.createElement(
    "textarea",
    {
      id: "a2a-message",
      rows: "3",
      maxLength: "32000",
      value: drafts[selected] || "",
      onChange: (event) => {
        const value = event.target.value;
        setDrafts((current) => ({ ...current, [selected]: value }));
      },
      disabled: !selected || busy || waiting.has(chat?.state),
      placeholder: "\u8F93\u5165\u6D88\u606F\u2026"
    }
  ), /* @__PURE__ */ import_react.default.createElement("div", null, /* @__PURE__ */ import_react.default.createElement("small", null, target && !target.online ? "Agent \u79BB\u7EBF\uFF0C\u5386\u53F2\u4F1A\u8BDD\u4ECD\u53EF\u67E5\u770B\u3002" : "\u6BCF\u4E2A Agent \u4FDD\u7559\u72EC\u7ACB\u4F1A\u8BDD\u548C\u4E0A\u4E0B\u6587\u3002"), /* @__PURE__ */ import_react.default.createElement("button", { type: "submit", disabled: !selected || busy || !chat || !target?.online || !!listError || waiting.has(chat?.state) || !drafts[selected]?.trim() }, busy ? "\u6B63\u5728\u53D1\u9001\u2026" : "\u53D1\u9001\u6D88\u606F")))));
}
var inject = ["slots", "remote"];
function apply(ctx) {
  ctx.effect(() => ctx.remote.$mount(controlContract));
  ctx.inject(["remote.a2aControl"], (scope) => {
    scope.slots.inject("main", () => scope.slots.register({
      name: "main",
      key: "a2a-control",
      inject: () => ({ remote: scope.remote.a2aControl })
    }, ControlPage));
    scope.slots.inject("sidebar.panellist", () => scope.slots.register({ name: "sidebar.panellist", id: "a2a-control", order: -10, label: "\u8FDC\u7A0B Agents" }, () => import_react.default.createElement("span", { "aria-hidden": true }, "\u25C9")));
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

return module.exports;}});
