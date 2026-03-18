# -*- coding: utf-8 -*-
"""
VCPToolBox 终端对话窗口
通过 VCP 中间层 (localhost:6005) 与 AI 进行流式对话
"""
import sys
import os
import json

# Windows 终端强制 UTF-8 输出
if sys.platform == "win32":
    os.system("chcp 65001 >nul 2>&1")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

try:
    import requests
except ImportError:
    print("请先安装 requests: pip install requests")
    sys.exit(1)

# ── 配置 ──────────────────────────────────────────────
VCP_URL   = "http://localhost:6005"
VCP_KEY   = "VCPAccessKey2024"
MODEL     = "google/gemini-3.1-flash-lite-preview"
MAX_TURNS = 50
# ──────────────────────────────────────────────────────

BANNER = f"""
========================================
  VCPToolBox 终端对话窗口
  模型: {MODEL}
  输入 /quit 退出  /clear 清空上下文
========================================
"""


def stream_chat(messages: list) -> str:
    """发送流式请求并逐字打印，返回完整回复"""
    url = f"{VCP_URL}/v1/chat/completions"
    payload = {
        "model": MODEL,
        "messages": messages,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {VCP_KEY}",
        "Content-Type": "application/json",
    }

    full_reply = []
    try:
        with requests.post(url, headers=headers, json=payload, stream=True, timeout=120) as r:
            if r.status_code != 200:
                print(f"\n[错误] HTTP {r.status_code}: {r.text[:300]}")
                return ""

            for raw_line in r.iter_lines():
                if not raw_line:
                    continue

                # 用 UTF-8 解码原始字节
                line = raw_line.decode("utf-8", errors="replace")

                # 跳过 SSE 注释行（如 VCP 心跳 ": vcp-keepalive"）
                if line.startswith(":"):
                    continue

                if not line.startswith("data: ") and not line.startswith("data:"):
                    continue

                # 提取 data: 后面的内容
                data_str = line[6:] if line.startswith("data: ") else line[5:]
                data_str = data_str.strip()

                if data_str == "[DONE]":
                    break

                if not data_str:
                    continue

                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                # 安全提取 delta 内容（VCP 某些 chunk 的 choices 可能为空）
                choices = chunk.get("choices")
                if not choices:
                    continue

                delta = choices[0].get("delta", {})
                content = delta.get("content", "")
                if content:
                    print(content, end="", flush=True)
                    full_reply.append(content)

    except requests.exceptions.ConnectionError:
        print("\n[错误] 无法连接到 VCP 服务，请确认 server.js 正在运行")
        return ""
    except requests.exceptions.Timeout:
        print("\n[错误] 请求超时")
        return ""
    except KeyboardInterrupt:
        print("\n[中断]")
        return "".join(full_reply)

    print()
    return "".join(full_reply)


def main():
    print(BANNER)
    system_prompt = {"role": "system", "content": "当前时间：{{Date}} {{Time}} {{Today}} {{Festival}}。当前地点{{VarCity}}当前的实时天气信息是：{{VCPWeatherInfo}}你是一个有用的 AI 助手。"}
    history: list[dict] = [system_prompt]

    while True:
        try:
            user_input = input("\n你: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见！")
            break

        if not user_input:
            continue
        if user_input.lower() == "/quit":
            print("再见！")
            break
        if user_input.lower() == "/clear":
            history = [system_prompt]
            print("[上下文已清空]")
            continue

        history.append({"role": "user", "content": user_input})

        if len(history) > MAX_TURNS * 2:
            history = history[-(MAX_TURNS * 2):]

        print("\nAI: ", end="", flush=True)
        reply = stream_chat(history)

        if reply:
            history.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    main()
