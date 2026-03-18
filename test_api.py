# -*- coding: utf-8 -*-
"""
VCPToolBox API 连通性测试脚本
验证后端 API（localhost:3000）和 VCP 中间层（localhost:6005）是否正常工作
"""
import sys
import io

# 强制 stdout 使用 UTF-8，解决 Windows GBK 终端编码问题
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

try:
    import requests
except ImportError:
    print("❌ 缺少 requests 库，请运行: pip install requests")
    sys.exit(1)

# ── 配置区 ──────────────────────────────────────────────
BACKEND_URL    = "http://localhost:3000"
BACKEND_KEY    = "sk-GZrKcFQhlmaVEo38xYau0oquctIvIBzTz00YziELIxRhQSX2"

VCP_URL        = "http://localhost:6005"
VCP_KEY        = "VCPAccessKey2024"

TEST_MODEL     = "google/gemini-3.1-flash-lite-preview"
TIMEOUT        = 30
# ────────────────────────────────────────────────────────

CHAT_PAYLOAD = {
    "model": TEST_MODEL,
    "messages": [{"role": "user", "content": "你好，请用一句话回复我。"}],
    "max_tokens": 50,
    "stream": False,
}

def check_models(base_url: str, api_key: str, label: str) -> bool:
    """GET /v1/models 验证服务可达性"""
    url = f"{base_url}/v1/models"
    try:
        r = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=TIMEOUT)
        if r.status_code == 200:
            data = r.json()
            models = data.get("data", [])
            print(f"  ✅ 模型列表获取成功，共 {len(models)} 个模型")
            if models:
                names = [m.get("id", "?") for m in models[:5]]
                print(f"     前5个: {', '.join(names)}")
            return True
        else:
            print(f"  ⚠️  HTTP {r.status_code}: {r.text[:200]}")
            return False
    except requests.exceptions.ConnectionError:
        print(f"  ❌ 连接失败，{label} 服务未启动或地址错误")
        return False
    except Exception as e:
        print(f"  ❌ 异常: {e}")
        return False

def check_chat(base_url: str, api_key: str, label: str) -> bool:
    """POST /v1/chat/completions 验证对话接口"""
    url = f"{base_url}/v1/chat/completions"
    try:
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=CHAT_PAYLOAD,
            timeout=TIMEOUT,
        )
        if r.status_code == 200:
            data = r.json()
            content = data["choices"][0]["message"]["content"]
            print(f"  ✅ 对话接口正常，模型回复: 「{content[:80]}」")
            return True
        else:
            print(f"  ⚠️  HTTP {r.status_code}: {r.text[:300]}")
            return False
    except requests.exceptions.ConnectionError:
        print(f"  ❌ 连接失败")
        return False
    except (KeyError, IndexError) as e:
        print(f"  ⚠️  响应格式异常: {e}\n     原始响应: {r.text[:300]}")
        return False
    except Exception as e:
        print(f"  ❌ 异常: {e}")
        return False

def run():
    print("=" * 55)
    print("  VCPToolBox API 连通性测试")
    print("=" * 55)

    results = {}

    # ── 测试后端 API ──────────────────────────────────────
    print(f"\n🔷 后端 API ({BACKEND_URL})")
    print("  [1/2] 获取模型列表...")
    r1 = check_models(BACKEND_URL, BACKEND_KEY, "后端 API")
    print("  [2/2] 发送对话请求...")
    r2 = check_chat(BACKEND_URL, BACKEND_KEY, "后端 API")
    results["后端 API"] = r1 and r2

    # ── 测试 VCP 中间层 ───────────────────────────────────
    print(f"\n🔶 VCP 中间层 ({VCP_URL})")
    print("  [1/2] 获取模型列表...")
    r3 = check_models(VCP_URL, VCP_KEY, "VCP 中间层")
    print("  [2/2] 发送对话请求...")
    r4 = check_chat(VCP_URL, VCP_KEY, "VCP 中间层")
    results["VCP 中间层"] = r3 and r4

    # ── 汇总 ─────────────────────────────────────────────
    print("\n" + "=" * 55)
    print("  测试结果汇总")
    print("=" * 55)
    all_ok = True
    for label, ok in results.items():
        status = "✅ 正常" if ok else "❌ 异常"
        print(f"  {label:<12} {status}")
        if not ok:
            all_ok = False

    print()
    if all_ok:
        print("🎉 所有接口验证通过！")
    else:
        print("⚠️  部分接口存在问题，请检查服务状态和配置。")

if __name__ == "__main__":
    run()
