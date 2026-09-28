#!/bin/sh
# Prepare, pair, and run one local A2A Connector. No administrator approval is performed here.
set -eu
umask 077

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
ACTION=${1:-help}
if [ "$#" -gt 0 ]; then shift; fi
HOST=
INSTANCE=default
RELAY=
LOCAL=
STATE=
EXPECT_NAME=
PORT_START=9900
REQUEST_ONLY=0
CUSTOM_STATE=0
ALLOW_INSECURE=0

usage() {
  cat <<'EOF'
Usage: sh scripts/install-connector.sh install --host HOST --relay WSS_URL --local HTTP_ORIGIN [--instance NAME] [--expect-name CARD_NAME] [--state FILE] [--request-only]
       sh scripts/install-connector.sh status  --host HOST [--instance NAME] [--state FILE]
       sh scripts/install-connector.sh stop    --host HOST [--instance NAME] [--state FILE]
       sh scripts/install-connector.sh repair  --host HOST --relay WSS_URL --local HTTP_ORIGIN [--instance NAME] [--expect-name CARD_NAME] [--state FILE]

HOST: workbuddy, openclaw, hermes, or dsh. WorkBuddy uses its bundled CLI and
normal workbuddy.json/settings/PID files. Other hosts use an isolated standalone
Connector state; their host plugin or A2A adapter setup is separate.

Export A2A_LOCAL_TOKEN before install/repair when the local origin requires it.
The script never persists or prints that token. Approval remains with the Relay
administrator. status shows local progress; verify online state in the Relay UI.
Use --instance for separate state/PID/log/process names. --local auto scans loopback
ports from --port-start (default 9900) for an already-running Agent Card whose
name exactly matches --expect-name. It does not change the Agent server's port.
Auto discovery reads cards without a token; use an explicit --local if the Card
requires authentication. Duplicate matching names cause an error.
--allow-insecure permits ws://127.0.0.1/connect for local tests only.
EOF
}

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"; }

case "$ACTION" in
  install|status|stop|repair) ;;
  help|-h|--help) usage; exit 0 ;;
  *) usage >&2; fail "未知操作：$ACTION" ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host|--instance|--relay|--local|--state|--expect-name|--port-start)
      [ "$#" -ge 2 ] || fail "$1 缺少参数"
      case "$1" in
        --host) HOST=$2 ;;
        --instance) INSTANCE=$2 ;;
        --relay) RELAY=$2 ;;
        --local) LOCAL=$2 ;;
        --state) STATE=$2; CUSTOM_STATE=1 ;;
        --expect-name) EXPECT_NAME=$2 ;;
        --port-start) PORT_START=$2 ;;
      esac
      shift 2 ;;
    --request-only) REQUEST_ONLY=1; shift ;;
    --allow-insecure) ALLOW_INSECURE=1; shift ;;
    *) fail "未知参数：$1" ;;
  esac
done

case "$HOST" in workbuddy|openclaw|hermes|dsh) ;; *) fail '使用 --host 指定 workbuddy、openclaw、hermes 或 dsh' ;; esac
case "$INSTANCE" in
  ''|*[!a-z0-9_-]*|-*|_*) fail '--instance 只能使用小写字母、数字、连字符和下划线，且须以字母或数字开头' ;;
esac
[ "${#INSTANCE}" -le 32 ] || fail '--instance 最多 32 个字符'
if [ "$ACTION" = install ] || [ "$ACTION" = repair ]; then
  [ "$INSTANCE" = default ] || [ -n "$EXPECT_NAME" ] || fail '多实例模式需要 --expect-name，防止连到其他 Agent 的端口'
  [ "$LOCAL" != auto ] || [ -n "$EXPECT_NAME" ] || fail '--local auto 需要 --expect-name'
fi
[ "$REQUEST_ONLY" -eq 0 ] || [ "$ACTION" = install ] || fail '--request-only 仅用于 install'
[ "$ALLOW_INSECURE" -eq 0 ] || [ "$ACTION" = install ] || [ "$ACTION" = repair ] || fail '--allow-insecure 仅用于 install/repair'
need node
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 22 ] || fail "需要 Node.js 22+，当前为 $(node --version)"
[ -n "${HOME:-}" ] || fail 'HOME 未设置'

if [ -z "$STATE" ]; then
  if [ "$HOST" = workbuddy ]; then
    if [ "$INSTANCE" = default ]; then STATE="$HOME/.config/a2a-connector/workbuddy.json"
    else STATE="$HOME/.config/a2a-connector/workbuddy-$INSTANCE.json"; fi
  else
    if [ "$INSTANCE" = default ]; then STATE="$HOME/.config/a2a-connector/standalone-$HOST.json"
    else STATE="$HOME/.config/a2a-connector/standalone-$HOST-$INSTANCE.json"; fi
  fi
fi
case "$STATE" in /*) ;; *) fail '--state 必须是绝对路径' ;; esac
[ "$HOST" != workbuddy ] || [ "$CUSTOM_STATE" -eq 0 ] || fail 'WorkBuddy 包装 CLI 使用固定状态路径，不支持 --state'
STATE_DIR=$(dirname "$STATE")
mkdir -p "$STATE_DIR"
node - "$STATE_DIR" <<'NODE' || fail "状态目录权限不安全；请将它设为 0700：$STATE_DIR"
const fs = require('node:fs');
const dir = process.argv[2];
if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o077)) process.exit(1);
NODE
if [ "$ACTION" = install ] || [ "$ACTION" = repair ]; then
  LOCK="$STATE.setup.lock"
  mkdir "$LOCK" 2>/dev/null || fail "已有安装/恢复操作在进行：$LOCK"
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT HUP INT TERM
fi
if [ "$HOST" = workbuddy ]; then
  export A2A_CONNECTOR_INSTANCE="$INSTANCE"
  if [ "$INSTANCE" = default ]; then WB_PREFIX=workbuddy
  else WB_PREFIX="workbuddy-$INSTANCE"; fi
  WB_CLI="$ROOT/plugins/workbuddy/cli.js"
  CLI="$ROOT/plugins/workbuddy/vendor/connector/cli.js"
  PID_FILE="$STATE_DIR/$WB_PREFIX.pid"
  SETTINGS="$STATE_DIR/$WB_PREFIX-settings.json"
  DEPENDENCIES="$ROOT/plugins/workbuddy"
else
  CLI="$ROOT/src/cli.js"
  PID_FILE="$STATE.setup.pid"
  DEPENDENCIES="$ROOT"
fi
if [ "$HOST" = workbuddy ]; then LOG_FILE="$STATE_DIR/$WB_PREFIX.stderr.log"
else LOG_FILE="$STATE.setup.log"; fi
PROCESS_NAME=$(node - "$STATE" <<'NODE'
const { createHash } = require('node:crypto');
const { basename } = require('node:path');
const path = process.argv[2];
const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);
const label = basename(path).replace(/\.json$/, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
console.log(`a2a-${hash}-${label}`);
NODE
)
PROCESS_SIGNATURE=$(printf '%s' "$PROCESS_NAME" | cut -c1-12)

read_state() {
  node - "$STATE" <<'NODE'
const fs = require('node:fs');
const state = process.argv[2];
for (const [path, label] of [[state, 'paired'], [state + '.pending', 'pending']]) {
  if (!fs.existsSync(path)) continue;
  const stat = fs.statSync(path);
  if (process.platform !== 'win32' && (stat.mode & 0o077)) {
    console.error(`状态文件权限不是 0600：${path}`);
    process.exit(1);
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { console.error(`状态文件不是有效 JSON：${path}`); process.exit(1); }
  if (!data.agentId || (label === 'paired' ? !data.token : !data.requestId || !data.confirmationCode)) {
    console.error(`状态文件缺少必要字段：${path}`);
    process.exit(1);
  }
  console.log(label + '|' + data.agentId + '|' + (label === 'pending' ? data.confirmationCode : ''));
  process.exit(0);
}
console.log('none||');
NODE
}

live_pid() {
  [ -f "$PID_FILE" ] || return 1
  PID=$(cat "$PID_FILE")
  case "$PID" in ''|*[!0-9]*) fail "PID 文件无效：$PID_FILE" ;; esac
  [ "$PID" -gt 0 ] && kill -0 "$PID" 2>/dev/null
}

assert_no_other_process() {
  need pgrep
  OTHERS=$(pgrep -af 'vendor/connector/cli.js|src/cli.js|a2a-[0-9a-f]{8}' 2>/dev/null |
    awk -v state="$STATE" -v signature="$PROCESS_SIGNATURE" -v self="$$" \
      '$1 != self && (index($0, state) > 0 || index($0, signature) > 0) { print $1 }' || true)
  [ -z "$OTHERS" ] || fail "另有 Connector 进程使用此状态文件（PID：$OTHERS）；先停止并核实它，未创建新请求"
}

show_status() {
  INFO=$(read_state) || fail '无法安全读取状态文件；请检查权限和内容'
  KIND=${INFO%%|*}
  REST=${INFO#*|}
  AGENT_ID=${REST%%|*}
  case "$KIND" in
    paired) note "本机凭据：已保存；Agent ID：$AGENT_ID" ;;
    pending) note "审批状态：待处理；Agent ID：${AGENT_ID}；六位确认码：${REST#*|}" ;;
    none) note '本机状态：未配对' ;;
  esac
  if live_pid; then
    note "Connector 进程：运行中（${PROCESS_NAME}，PID ${PID}）"
    if command -v lsof >/dev/null 2>&1 && lsof -nP -a -p "$PID" -iTCP -sTCP:ESTABLISHED >/dev/null 2>&1; then
      note '网络检查：进程有已建立 TCP 连接；仍需核对 Relay 页面与实际 A2A 请求。'
    else
      note '网络检查：未观测到已建立 TCP 连接；等待审批或检查 Relay 连通性。'
    fi
  else
    note 'Connector 进程：未运行。'
    if [ -f "$LOG_FILE" ]; then
      if grep -qE 'status 401|rejected \(401\)' "$LOG_FILE"; then note '上次日志含 401；先检查凭据和 .state-*，再运行 repair。'; fi
      if grep -qE 'status 409|already uses this Agent ID' "$LOG_FILE"; then note '上次日志含 409；Relay 可能已有同 ID 的待审批请求。'; fi
    fi
  fi
}

stop_runner() {
  if ! live_pid; then
    [ ! -f "$PID_FILE" ] || rm "$PID_FILE"
    note '没有运行中的脚本管理进程。'
    return
  fi
  OLD_PID=$PID
  # A PID file alone cannot rule out PID reuse. Prefer ps, then pgrep when ps is filtered.
  ARGS=$(ps -p "$PID" -o args= 2>/dev/null || true)
  if [ -z "$ARGS" ] && command -v pgrep >/dev/null 2>&1; then
    ARGS=$(pgrep -af 'vendor/connector/cli.js|src/cli.js|a2a-[0-9a-f]{8}' 2>/dev/null | awk -v pid="$PID" '$1 == pid { $1=""; print }' || true)
  fi
  case "$ARGS" in
    *"$CLI"*"$STATE"*|*"$PROCESS_SIGNATURE"*) ;;
    *) fail "无法核实 PID ${PID} 属于本安装器；未发送终止信号。" ;;
  esac
  if [ "$HOST" = workbuddy ]; then
    node "$WB_CLI" stop
  else
    kill -TERM "$PID"
    rm "$PID_FILE"
  fi
  COUNT=0
  while kill -0 "$OLD_PID" 2>/dev/null && [ "$COUNT" -lt 5 ]; do
    sleep 1
    COUNT=$((COUNT + 1))
  done
  kill -0 "$OLD_PID" 2>/dev/null && fail "PID ${OLD_PID} 尚未退出；没有移动状态文件"
  note '已请求 Connector 停止。'
}

if [ "$ACTION" = status ]; then show_status; exit 0; fi
if [ "$ACTION" = stop ]; then stop_runner; exit 0; fi

[ -n "$RELAY" ] && [ -n "$LOCAL" ] || fail 'install/repair 需要 --relay 和 --local'
AUTO_LOCAL=0
if [ "$LOCAL" = auto ]; then AUTO_LOCAL=1; fi
LOCAL=$(node --input-type=module - "$RELAY" "$LOCAL" "$ALLOW_INSECURE" "$EXPECT_NAME" "$PORT_START" <<'NODE'
const relay = new URL(process.argv[2]);
const requested = process.argv[3];
const allowInsecure = process.argv[4] === '1';
const expected = process.argv[5];
const startPort = Number(process.argv[6]);
if (relay.protocol !== 'wss:' && !(allowInsecure && relay.protocol === 'ws:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(relay.hostname)) ||
    relay.pathname !== '/connect' || relay.search || relay.hash || relay.username || relay.password)
  throw new Error('Relay 必须是 wss://.../connect');
const headers = process.env.A2A_LOCAL_TOKEN ? { authorization: `Bearer ${process.env.A2A_LOCAL_TOKEN}` } : {};
async function cardAt(origin, timeout, requestHeaders = {}) {
  const response = await fetch(new URL('/.well-known/agent-card.json', origin),
    { headers: requestHeaders, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const card = await response.json();
  if (typeof card.name !== 'string' || !card.name.trim()) throw new Error('Agent Card 缺少非空 name');
  return card;
}
if (requested === 'auto') {
  if (!expected) throw new Error('--local auto 需要 --expect-name');
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) throw new Error('--port-start 必须是有效端口');
  const matches = [];
  for (let port = startPort; port < Math.min(startPort + 20, 65536); port++) {
    const origin = `http://127.0.0.1:${port}`;
    try {
      // Never send a local Bearer token to an unverified port during discovery.
      const card = await cardAt(origin, 1500);
      if (card.name === expected) matches.push(origin);
    } catch { /* Another service, or no listener: try the next port. */ }
  }
  if (matches.length > 1) throw new Error(`发现多个 Agent Card name=${expected}：${matches.join(', ')}；请指定唯一名称或明确 --local`);
  if (!matches.length) throw new Error(`端口 ${startPort} 起的 20 个端口里没有找到可匿名读取的 Agent Card name=${expected}；先启动服务，若 Card 需要认证则明确指定 --local`);
  if (process.env.A2A_LOCAL_TOKEN) await cardAt(matches[0], 10000, headers);
  console.log(matches[0]);
  process.exit(0);
}
const local = new URL(requested);
if (!['http:', 'https:'].includes(local.protocol) || local.pathname !== '/' || local.search || local.hash || local.username || local.password)
  throw new Error('local 必须是 HTTP(S) origin，不带 endpoint 路径');
const card = await cardAt(local, 10000, headers);
if (expected && card.name !== expected) throw new Error(`端口已响应另一个 Agent：${card.name}；预期 ${expected}`);
console.log(local.origin);
NODE
) || fail '预检失败；尚未申请配对或修改凭据'
note "已确认本机 A2A origin：$LOCAL"

if [ "$ACTION" = repair ]; then
  INFO=$(read_state) || fail '状态文件无效，未执行恢复'
  case "$INFO" in paired\|*) fail '已有本机凭据；请先检查连接，不要重新配对' ;; esac
  if live_pid; then stop_runner; fi
  assert_no_other_process
  for orphan in "$STATE_DIR"/.state-*; do
    [ -e "$orphan" ] || continue
    fail "发现可能含有效凭据的临时文件：$orphan；未覆盖或删除它"
  done
  if [ -f "$STATE.pending" ]; then
    BACKUP="$STATE.pending.backup-$(date +%Y%m%d-%H%M%S)"
    mv "$STATE.pending" "$BACKUP"
    note "已归档失效的待审批文件：$BACKUP"
  fi
fi

if live_pid; then
  show_status
  exit 0
fi
assert_no_other_process
for orphan in "$STATE_DIR"/.state-*; do
  [ -e "$orphan" ] || continue
  [ -f "$STATE" ] || fail "发现可能含有效凭据的临时文件：${orphan}；先按文档核对"
done
need npm
if ! node - "$CLI" <<'NODE' >/dev/null 2>&1
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
createRequire(pathToFileURL(process.argv[2])).resolve('ws');
NODE
then
  note '安装 Connector 运行依赖…'
  npm ci --omit=dev --prefix "$DEPENDENCIES"
fi

if [ "$HOST" = workbuddy ]; then
  node - "$SETTINGS" "$RELAY" "$LOCAL" "$ALLOW_INSECURE" "$AUTO_LOCAL" <<'NODE' || fail 'WorkBuddy 设置与既有配置冲突；未覆盖'
const fs = require('node:fs');
const [file, relay, local] = process.argv.slice(2);
const allowInsecure = process.argv[5] === '1';
const autoLocal = process.argv[6] === '1';
if (fs.existsSync(file)) {
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (current.relay !== relay || !!current.allowInsecure !== allowInsecure ||
      (current.local !== local && !autoLocal)) {
    console.error('已有 workbuddy-settings.json 使用不同的 relay/local；请先检查现有身份。');
    process.exit(1);
  }
  if (current.local !== local) fs.writeFileSync(file, JSON.stringify({ ...current, local }), { mode: 0o600 });
} else fs.writeFileSync(file, JSON.stringify({ relay, local, allowInsecure }), { mode: 0o600, flag: 'wx' });
NODE
fi

note '检查或复用配对请求…'
set -- "$CLI" -relay "$RELAY" -local "$LOCAL" -state "$STATE"
if [ "$ALLOW_INSECURE" -eq 1 ]; then set -- "$@" -allow-insecure; fi
PAIRING=$(node "$@" -request-only) || fail '配对申请失败；检查 Relay 与现有 pending，未启动新进程'
node - "$PAIRING" <<'NODE'
const value = JSON.parse(process.argv[2]);
if (value.status === 'paired') console.log(`已有凭据：${value.agentId}`);
else if (value.status === 'pending') console.log(`等待管理员批准：${value.approvalURL} | Agent ID：${value.agentId} | 六位确认码：${value.confirmationCode}`);
else throw new Error('未知配对状态');
NODE
if [ "$REQUEST_ONLY" -eq 1 ]; then
  note '仅申请/检查模式：未启动 Connector。'
  exit 0
fi

if [ "$HOST" = workbuddy ]; then
  node "$WB_CLI" start
else
  : > "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  nohup node "$@" -auto-pair >> "$LOG_FILE" 2>&1 </dev/null &
  PID=$!
  printf '%s\n' "$PID" > "$PID_FILE"
  chmod 600 "$PID_FILE"
fi
sleep 1
live_pid || fail "Connector 启动后退出；检查私有日志 ${LOG_FILE}，不要直接贴出凭据"
note "Connector 已启动（PID ${PID}）。审批后运行 status 检查本机状态，并在 Relay 页面确认在线。"
