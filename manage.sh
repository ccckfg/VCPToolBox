#!/bin/bash

VCP_DIR="/root/VCPToolBox"
ASTRBOT_DIR="/root/VCPToolBox/AstrBot"
VCP_LOG="$VCP_DIR/vcp.log"
ASTRBOT_LOG="$VCP_DIR/astrbot.log"
VCP_PID_FILE="$VCP_DIR/vcp.pid"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

# ── VCP ──────────────────────────────────────────────

rotate_log() {
    local logfile="$1"
    local max_bytes=$((10 * 1024 * 1024))  # 10MB
    if [ -f "$logfile" ] && [ "$(stat -c%s "$logfile")" -ge "$max_bytes" ]; then
        mv "$logfile" "${logfile}.old"
    fi
}

vcp_start() {
    if [ -f "$VCP_PID_FILE" ] && kill -0 "$(cat "$VCP_PID_FILE")" 2>/dev/null; then
        warn "VCP 已在运行 (PID: $(cat "$VCP_PID_FILE"))"
        return
    fi
    rotate_log "$VCP_LOG"
    log "启动 VCP..."
    cd "$VCP_DIR" && nohup node server.js > "$VCP_LOG" 2>&1 &
    echo $! > "$VCP_PID_FILE"
    log "VCP 已启动 (PID: $!), 日志: $VCP_LOG"
}

vcp_stop() {
    if [ -f "$VCP_PID_FILE" ]; then
        PID=$(cat "$VCP_PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID" && rm -f "$VCP_PID_FILE"
            log "VCP 已停止 (PID: $PID)"
        else
            warn "VCP 进程不存在，清理 PID 文件"
            rm -f "$VCP_PID_FILE"
        fi
    else
        warn "VCP 未在运行"
    fi
}

vcp_status() {
    if [ -f "$VCP_PID_FILE" ] && kill -0 "$(cat "$VCP_PID_FILE")" 2>/dev/null; then
        log "VCP 运行中 (PID: $(cat "$VCP_PID_FILE"))"
    else
        warn "VCP 未运行"
    fi
}

# ── AstrBot ──────────────────────────────────────────

astrbot_start() {
    if pgrep -f "astrbot" > /dev/null 2>&1; then
        warn "AstrBot 已在运行"
        return
    fi
    rotate_log "$ASTRBOT_LOG"
    log "启动 AstrBot..."
    cd "$ASTRBOT_DIR" && nohup uv run astrbot > "$ASTRBOT_LOG" 2>&1 &
    log "AstrBot 已启动 (PID: $!), 日志: $ASTRBOT_LOG"
}

astrbot_stop() {
    PIDS=$(pgrep -f "astrbot")
    if [ -n "$PIDS" ]; then
        echo "$PIDS" | xargs kill
        log "AstrBot 已停止"
    else
        warn "AstrBot 未在运行"
    fi
}

astrbot_status() {
    if pgrep -f "astrbot" > /dev/null 2>&1; then
        log "AstrBot 运行中 (PID: $(pgrep -f astrbot | tr '\n' ' '))"
    else
        warn "AstrBot 未运行"
    fi
}

# ── 主逻辑 ───────────────────────────────────────────

usage() {
    echo "用法: $0 {start|stop|restart|status} {vcp|astrbot|all}"
    echo ""
    echo "  $0 start all       启动 VCP 和 AstrBot"
    echo "  $0 stop all        停止 VCP 和 AstrBot"
    echo "  $0 restart vcp     重启 VCP"
    echo "  $0 status all      查看运行状态"
    echo "  $0 log vcp         查看 VCP 日志"
    echo "  $0 log astrbot     查看 AstrBot 日志"
}

ACTION=$1
TARGET=$2

case "$ACTION" in
    start)
        case "$TARGET" in
            vcp) vcp_start ;;
            astrbot) astrbot_start ;;
            all) vcp_start; astrbot_start ;;
            *) usage ;;
        esac ;;
    stop)
        case "$TARGET" in
            vcp) vcp_stop ;;
            astrbot) astrbot_stop ;;
            all) vcp_stop; astrbot_stop ;;
            *) usage ;;
        esac ;;
    restart)
        case "$TARGET" in
            vcp) vcp_stop; sleep 1; vcp_start ;;
            astrbot) astrbot_stop; sleep 1; astrbot_start ;;
            all) vcp_stop; astrbot_stop; sleep 1; vcp_start; astrbot_start ;;
            *) usage ;;
        esac ;;
    status)
        case "$TARGET" in
            vcp) vcp_status ;;
            astrbot) astrbot_status ;;
            all|"") vcp_status; astrbot_status ;;
            *) usage ;;
        esac ;;
    log)
        case "$TARGET" in
            vcp) tail -f "$VCP_LOG" ;;
            astrbot) tail -f "$ASTRBOT_LOG" ;;
            *) usage ;;
        esac ;;
    *)
        usage ;;
esac
