#!/usr/bin/env bash
# =============================================================================
# 链田守护 · 开发环境一键启停脚本
#
# 管理四层组件(按依赖顺序):
#   1. Fabric 网络 —— peer0.org1/org2、orderer、CA 容器(只 stop/start,不删除)
#   2. IPFS        —— Kubo 容器(5001 API / 8080 网关)
#   3. 后端        —— Express API(默认 3000,后台运行)
#   4. 前端        —— Vite 开发服务器(默认 5173,后台运行)
#
# 用法(仓库根目录):
#   ./scripts/envctl.sh deploy    # 一键部署:网络 + 链码 + IPFS + 钱包 + 依赖 + 启动前后端
#   ./scripts/envctl.sh start     # 一键启动全部组件(已启动的自动跳过)
#   ./scripts/envctl.sh stop      # 一键停止全部组件(容器保留,数据不丢)
#   ./scripts/envctl.sh restart   # 先 stop 再 start
#   ./scripts/envctl.sh status    # 查看各组件运行状态
#   ./scripts/envctl.sh clean     # 彻底清理:拆除网络/容器/卷/证书/钱包(需确认)
#
# 说明:
#   - Fabric 容器用 docker stop/start 而非 network.sh down/up:不删容器与卷,
#     账本数据完整保留,日常开关机后重启速度快(关机后容器全部 Exited 属正常);
#   - deploy 是"从零到可用"的完整路径:首次搭建或 clean 之后执行一次即可,
#     链码已提交时会自动递增 sequence 重新部署最新代码;
#   - clean 会彻底删除容器/卷/证书/钱包(恢复到未搭建状态),
#     需要重新 deploy 才能使用;源码与 node_modules 依赖保留;
#   - 链码容器(dev-peer*)无需手动启动,peer 收到交易请求时会自动拉起;
#   - IPFS 数据存放在命名卷 ${IPFS_VOLUME} 中(clean 不删除,数据持久保留);
#     仓库上限默认 ${IPFS_STORAGE_MAX},可用环境变量覆盖:
#       IPFS_STORAGE_MAX=50GB ./scripts/envctl.sh start
#   - 前后端日志与 PID 文件在 logs/ 目录,排查问题先看日志。
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

# ---- 可配置项(可用环境变量覆盖) ----
IPFS_STORAGE_MAX="${IPFS_STORAGE_MAX:-10GB}"  # IPFS 仓库上限(Kubo StorageMax,如 20GB)
IPFS_VOLUME="${IPFS_VOLUME:-ipfs-data}"       # IPFS 数据命名卷(clean 不删,数据持久保留)

step() { printf "\n${BLUE}━━━ %s${NC}\n" "$1"; }
ok()   { printf "${GREEN}  ✔ ${NC}%s\n" "$1"; }
info() { printf "${YELLOW}  → ${NC}%s\n" "$1"; }
warn() { printf "${RED}  ✘ ${NC}%s\n" "$1"; }

# ---- Node 探测:优先 nvm 安装的 node(项目用 v22),fallback 系统 node ----
find_node() {
  local v
  for v in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$v" ] && { echo "$v"; return 0; }
  done
  command -v node 2>/dev/null || echo ""
}
NODE="$(find_node)"
if [ -z "$NODE" ]; then
  warn "未找到 node,请先安装 Node.js 22+(nvm)"
  exit 1
fi

# ---- npm 探测(与 node 同源,优先 nvm) ----
find_npm() {
  local v
  for v in "$HOME"/.nvm/versions/node/*/bin/npm; do
    [ -x "$v" ] && { echo "$v"; return 0; }
  done
  command -v npm 2>/dev/null || echo ""
}
NPM="$(find_npm)"

# ---- go 探测(链码部署 go mod vendor 需要) ----
find_go() {
  if command -v go >/dev/null 2>&1; then command -v go; return 0; fi
  [ -x /usr/local/go/bin/go ] && { echo /usr/local/go/bin/go; return 0; }
  echo ""
}
GO_BIN="$(find_go)"

# ---- 工具函数 ----
# 端口是否已被监听(/dev/tcp 探测,bash 内建)
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&-; return 0; } || return 1; }

# Fabric 网络容器(全部 / 运行中);dev-peer 链码容器不带该 label,由 peer 自动拉起
fab_containers_all() { docker ps -aq --filter label=service=hyperledger-fabric 2>/dev/null || true; }
fab_containers_up()  { docker ps -q  --filter label=service=hyperledger-fabric 2>/dev/null || true; }

# 按 PID 文件停止后台进程(由本脚本启动的服务)
stop_process() { # $1=服务名 $2=pid 文件
  if [ -f "$2" ]; then
    local pid
    pid="$(cat "$2")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      ok "已停止 $1(PID $pid)"
    else
      info "$1 进程已不在(PID $pid),跳过"
    fi
    rm -f "$2"
  else
    info "$1 未由本脚本启动(无 PID 文件),若在运行请手动停止"
  fi
}

# ---- 启动 ----
start_fabric() {
  local all
  all="$(fab_containers_all)"
  if [ -z "$all" ]; then
    warn "未找到 Fabric 容器。首次搭建请先执行:"
    warn "  cd network && ./network.sh up createChannel -ca"
    warn "  ./network.sh deployCC -ccn agrichain -ccp ../chaincode/agrichain/cmd -ccl go -ccs 3"
    return 1
  fi
  # shellcheck disable=SC2086
  docker start $all > /dev/null
  ok "Fabric 容器已启动($(echo "$all" | wc -l) 个;链码容器将按需自动拉起)"
}

start_ipfs() {
  if docker ps -a --format '{{.Names}}' | grep -qx ipfs; then
    docker start ipfs > /dev/null
  else
    info "首次运行:创建 IPFS 容器(数据卷 ${IPFS_VOLUME},仓库上限 ${IPFS_STORAGE_MAX})"
    docker run -d --name ipfs -v "${IPFS_VOLUME}:/data/ipfs" \
      -p 5001:5001 -p 8080:8080 ipfs/kubo > /dev/null
  fi
  # 应用存储上限配置(幂等;仅值变化时重启守护进程生效)
  apply_ipfs_storage_max
  ok "IPFS 容器已启动(API 5001 / 网关 8080;数据卷 ${IPFS_VOLUME} 持久保留)"
}

# 将 IPFS_STORAGE_MAX 写入容器配置。daemon 运行时 ipfs config 命令会被
# repo.lock 挡住,因此直接读改 /data/ipfs/config 文件 + 重启守护进程生效。
# 容器刚启动时文件可能未就绪,重试至多 10 次后放弃(不影响启动)。
apply_ipfs_storage_max() {
  local cur="" i
  for i in $(seq 1 10); do
    cur="$(docker exec ipfs grep -o '"StorageMax": *"[^"]*"' /data/ipfs/config 2>/dev/null | grep -o '"[^"]*"$' | tr -d '\"')"
    [ -n "$cur" ] && break
    sleep 1
  done
  if [ -z "$cur" ]; then
    info "无法读取当前 IPFS 仓库上限(容器未就绪),跳过容量配置"
    return 0
  fi
  if [ "$cur" != "$IPFS_STORAGE_MAX" ]; then
    docker exec ipfs sed -i "s/\"StorageMax\": *\"[^\"]*\"/\"StorageMax\": \"${IPFS_STORAGE_MAX}\"/" /data/ipfs/config
    docker restart ipfs >/dev/null 2>&1
    info "IPFS 仓库上限已调整:${cur} → ${IPFS_STORAGE_MAX}(已重启生效)"
  fi
}

start_backend() {
  if port_open 3000; then
    info "端口 3000 已被监听,后端已在运行,跳过"
    return 0
  fi
  mkdir -p "$LOG_DIR"
  (
    cd "$ROOT_DIR/backend"
    nohup "$NODE" src/server.js >> "$LOG_DIR/backend.log" 2>&1 &
    echo $! > "$LOG_DIR/backend.pid"
  )
  info "后端已后台启动,日志 logs/backend.log(PID $(cat "$LOG_DIR/backend.pid"))"
}

start_frontend() {
  if port_open 5173; then
    info "端口 5173 已被监听,前端已在运行,跳过"
    return 0
  fi
  mkdir -p "$LOG_DIR"
  (
    cd "$ROOT_DIR/frontend"
    nohup "$NODE" node_modules/vite/bin/vite.js >> "$LOG_DIR/frontend.log" 2>&1 &
    echo $! > "$LOG_DIR/frontend.pid"
  )
  info "前端已后台启动,日志 logs/frontend.log(PID $(cat "$LOG_DIR/frontend.pid"))"
}

# ---- 停止 ----
stop_frontend() {
  stop_process "前端" "$LOG_DIR/frontend.pid"
}

stop_backend() {
  stop_process "后端" "$LOG_DIR/backend.pid"
}

stop_ipfs() {
  if docker ps --format '{{.Names}}' | grep -qx ipfs; then
    docker stop ipfs > /dev/null
    ok "IPFS 容器已停止(容器保留,数据不丢)"
  else
    info "IPFS 容器未在运行,跳过"
  fi
}

stop_fabric() {
  local up
  up="$(fab_containers_up)"
  if [ -z "$up" ]; then
    info "Fabric 容器未在运行,跳过"
    return 0
  fi
  # shellcheck disable=SC2086
  docker stop $up > /dev/null
  ok "Fabric 容器已停止(容器与账本数据保留,下次 start 快速恢复)"
}

# ---- 部署(从零到可用) ----
check_prereqs() {
  step "0/7 前置检查"
  command -v docker >/dev/null 2>&1 || { warn "未找到 docker(需 Docker Desktop + WSL 集成)"; exit 1; }
  ok "docker 可用"
  ok "node 可用($NODE)"
  if [ -n "$NPM" ]; then ok "npm 可用($NPM)"; else warn "未找到 npm,依赖安装将失败"; exit 1; fi
  if [ -n "$GO_BIN" ]; then ok "go 可用($GO_BIN)"; else warn "未找到 go,链码部署(go mod vendor)需要 Go 1.22+"; exit 1; fi
  if [ -x "$ROOT_DIR/bin/peer" ]; then ok "fabric peer 二进制可用"; else
    warn "缺少 fabric 工具链(peer 二进制),请从 fabric-samples 链接:"
    warn "  ln -s <fabric-samples>/bin $ROOT_DIR/bin"
    exit 1
  fi
}

# 查询已提交链码的 sequence;未提交则返回空
cc_committed_sequence() {
  (
    cd "$ROOT_DIR/network" || exit 0
    export PATH="$ROOT_DIR/bin:$PATH"
    export FABRIC_CFG_PATH="$ROOT_DIR/config"
    export TEST_NETWORK_HOME="$ROOT_DIR/network"
    export VERBOSE=false OVERRIDE_ORG=""   # envVar.sh 会引用这两个变量(set -u 下必须定义)
    . scripts/envVar.sh >/dev/null 2>&1
    setGlobals 1 >/dev/null 2>&1
    peer lifecycle chaincode querycommitted -C agri-channel -n agrichain 2>/dev/null \
      | grep -o 'Sequence: [0-9]*' | head -1 | grep -o '[0-9]*'
  ) || true
}

deploy_fabric() {
  if [ -n "$(fab_containers_all)" ]; then
    start_fabric
  else
    info "首次搭建:创建通道与身份(./network.sh up createChannel -ca)"
    (
      cd "$ROOT_DIR/network"
      export PATH="$ROOT_DIR/bin:$PATH"
      ./network.sh up createChannel -ca
    )
    ok "Fabric 网络已创建"
  fi
}

deploy_chaincode() {
  local seq
  seq="$(cc_committed_sequence)"
  if [ -z "$seq" ]; then
    seq=1
    info "链码尚未提交,以 sequence 1 首次部署"
  else
    info "检测到已提交链码(sequence $seq),自动递增重新部署最新代码"
    seq=$((seq + 1))
  fi
  (
    cd "$ROOT_DIR/network"
    export PATH="$ROOT_DIR/bin:$(dirname "$GO_BIN"):$PATH"
    export GOCACHE="${GOCACHE:-$ROOT_DIR/.toolchain/gocache}"
    export GOPATH="${GOPATH:-$ROOT_DIR/.toolchain/gopath}"
    ./network.sh deployCC -ccn agrichain -ccp ../chaincode/agrichain/cmd -ccl go -ccs "$seq"
  )
  ok "链码已部署(sequence $seq)"
}

deploy_backend_deps() {
  if [ ! -d "$ROOT_DIR/backend/node_modules" ]; then
    info "安装后端依赖(npm install)"
    (cd "$ROOT_DIR/backend" && "$NPM" install --no-audit --no-fund)
  else
    info "后端依赖已安装,跳过"
  fi
  (cd "$ROOT_DIR/backend" && "$NODE" scripts/setup-wallet.js)
  ok "钱包身份已导入(operator/checker/auditor/regulator)"
}

deploy_frontend_deps() {
  if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
    info "安装前端依赖(npm install)"
    (cd "$ROOT_DIR/frontend" && "$NPM" install --no-audit --no-fund)
  else
    info "前端依赖已安装,跳过"
  fi
}

do_deploy() {
  check_prereqs
  step "1/7 Fabric 网络"
  deploy_fabric
  step "2/7 链码部署(agrichain)"
  deploy_chaincode
  step "3/7 IPFS"
  start_ipfs
  step "4/7 后端依赖与钱包身份"
  deploy_backend_deps
  step "5/7 前端依赖"
  deploy_frontend_deps
  step "6/7 启动前后端服务"
  start_backend
  start_frontend
  step "7/7 健康检查(等待链路就绪)"
  for _ in 1 2 3 4 5 6; do
    if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      ok "后端健康检查通过:"
      curl -s http://127.0.0.1:3000/api/health
      echo ""
      step "部署完成"
      info "前端:浏览器打开 http://127.0.0.1:5173"
      info "演示:./scripts/demo.sh;测试:后端单测/e2e 见 backend/README.md"
      return 0
    fi
    sleep 5
  done
  warn "健康检查超时,请查看 logs/backend.log 排查"
  return 1
}

# ---- 清理(恢复到未搭建状态) ----
do_clean() {
  warn "即将彻底清理本地环境(源码与 node_modules 保留):"
  warn "  - 停止前后端服务"
  warn "  - 拆除 Fabric 网络:容器/卷/证书/通道文件全删(./network.sh down)"
  warn "  - 删除 IPFS 容器"
  warn "  - 删除 backend/wallet、logs、链码打包文件"
  if [ "${2:-}" != "-y" ]; then
    read -r -p "确认继续?[y/N] " ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { info "已取消"; exit 0; }
  fi

  step "1/4 停止前后端"
  stop_frontend
  stop_backend

  step "2/4 拆除 Fabric 网络"
  (
    cd "$ROOT_DIR/network"
    export PATH="$ROOT_DIR/bin:$PATH"
    ./network.sh down
  ) || warn "network.sh down 返回非零(卷已删等无害报错),继续清理"

  step "3/4 删除 IPFS 容器(数据卷保留)"
  if docker rm -f ipfs >/dev/null 2>&1; then
    ok "IPFS 容器已删除(数据卷 ${IPFS_VOLUME} 保留,数据不丢;彻底删除:docker volume rm ${IPFS_VOLUME})"
  else
    info "IPFS 容器不存在,跳过"
  fi

  step "4/4 清理本地生成物"
  rm -rf "$ROOT_DIR/backend/wallet"
  rm -rf "$ROOT_DIR/logs"
  rm -f "$ROOT_DIR"/network/*.tar.gz
  ok "钱包/日志/链码打包文件已清理"
  step "清理完成"
  info "重新部署:./scripts/envctl.sh deploy"
}

# ---- 状态 ----
show_status() {
  step "环境状态"
  echo "── 容器 ──"
  docker ps -a --filter label=service=hyperledger-fabric --format '  {{.Names}}\t{{.Status}}' 2>/dev/null | sort
  docker ps -a --filter 'name=^ipfs$' --format '  {{.Names}}\t{{.Status}}' 2>/dev/null
  echo "── 服务端口 ──"
  for p in 3000:后端 5173:前端 5001:IPFS网关; do
    local port="${p%%:*}" name="${p##*:}"
    if port_open "$port"; then
      ok "$name(端口 $port)已监听"
    else
      info "$name(端口 $port)未监听"
    fi
  done
  echo "── 后端健康检查 ──"
  curl -s http://127.0.0.1:3000/api/health && echo "" || info "后端健康检查不可达(需先 start)"
}

# ---- 入口 ----
case "${1:-}" in
  start)
    step "1/4 启动 Fabric 网络"
    start_fabric
    step "2/4 启动 IPFS"
    start_ipfs
    step "3/4 启动后端"
    start_backend
    step "4/4 启动前端"
    start_frontend
    step "启动完成"
    info "验证:curl http://127.0.0.1:3000/api/health"
    info "前端:浏览器打开 http://127.0.0.1:5173"
    ;;
  stop)
    step "1/4 停止前端"
    stop_frontend
    step "2/4 停止后端"
    stop_backend
    step "3/4 停止 IPFS"
    stop_ipfs
    step "4/4 停止 Fabric 网络"
    stop_fabric
    step "停止完成(容器保留,可随时 start 恢复)"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    show_status
    ;;
  deploy)
    do_deploy
    ;;
  clean)
    do_clean "$@"
    ;;
  *)
    echo "用法: $0 deploy|start|stop|restart|status|clean"
    exit 1
    ;;
esac
