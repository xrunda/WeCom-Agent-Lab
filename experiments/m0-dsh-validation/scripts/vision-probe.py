#!/usr/bin/env python3
"""M0 #28 看图摸底：把餐食照片 / 化验单发给 DeepSeek V4.1 Flash。

依赖：Python 3.9+，只用标准库。需要 DSH Web 已启动并加载 zhiban-m0 插件。

用法：
  python3 scripts/vision-probe.py --assets ./.cache/m0-images --out ./.cache/m0-results

每张图新建一个会话，避免上一张图的上下文影响下一张。响应原文（含 reply_draft
参数、耗时、token usage）写入 out 目录；控制台只打印摘要。
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import time
import urllib.error
import urllib.request

MEAL_QUESTION = (
    "这是一张餐食照片。请识别主要食物、大致份量和烹饪方式，并估算热量、碳水、蛋白质、脂肪。"
    "只描述你看到的，不给医疗建议；看不清或不确定的地方请明确说明。"
    "请把完整分析写进 reply_draft 的 body，不要只写摘要。"
)
LAB_QUESTION = (
    "这是一张化验单照片。请逐项读出指标名称、结果、单位、参考范围和异常标记，"
    "然后给一句总体解读。不要编造看不清的内容。"
    "请把完整逐项转录写进 reply_draft 的 body，不要只写摘要。"
)


def post_json(base: str, path: str, payload: dict, timeout: int = 300) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        base.rstrip("/") + path,
        data=body,
        headers={"content-type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error


def guess_media_type(path: str) -> str:
    media_type, _ = mimetypes.guess_type(path)
    if media_type in {"image/jpeg", "image/png", "image/webp"}:
        return media_type
    raise ValueError(f"不支持的图片类型：{path}")


def summarize(result: dict) -> dict:
    turns = result.get("turns") or []
    last = turns[-1] if turns else {}
    drafts = []
    for turn in turns:
        for draft in turn.get("drafts") or []:
            drafts.append(
                {
                    "turn": turn.get("turn"),
                    "body": draft.get("body", ""),
                    "riskLevel": draft.get("riskLevel"),
                }
            )
    usage = None
    for message in result.get("assistantMessages") or []:
        if message.get("usage"):
            usage = message["usage"]
    return {
        "sessionId": result.get("sessionId"),
        "turn": last.get("turn"),
        "reason": last.get("reason"),
        "durationMs": result.get("durationMs"),
        "assistantText": last.get("assistantText", ""),
        "drafts": drafts,
        "usage": usage,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:3399", help="DSH Web 根地址")
    parser.add_argument("--assets", required=True, help="图片目录")
    parser.add_argument("--out", required=True, help="结果输出目录")
    parser.add_argument("--timeout", type=int, default=300, help="单张图等待秒数")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    names = sorted(
        name
        for name in os.listdir(args.assets)
        if name.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
    )
    if not names:
        print(f"没有找到图片：{args.assets}")
        return 1

    summary_rows = []
    for name in names:
        path = os.path.join(args.assets, name)
        question = LAB_QUESTION if "lab" in name.lower() else MEAL_QUESTION
        started = time.time()
        try:
            result = post_json(
                args.base,
                "/zhiban-m0/image-turn",
                {
                    "imageBase64": base64.b64encode(open(path, "rb").read()).decode("ascii"),
                    "mediaType": guess_media_type(path),
                    "imageName": name,
                    "question": question,
                },
                timeout=args.timeout,
            )
        except Exception as error:  # noqa: BLE001 - 验证脚本需要把失败也记录下来
            row = {"file": name, "error": str(error), "elapsedSeconds": round(time.time() - started, 2)}
            summary_rows.append(row)
            print(f"[失败] {name}: {error}")
            continue

        result["file"] = name
        result["elapsedSeconds"] = round(time.time() - started, 2)
        out_path = os.path.join(args.out, f"{os.path.splitext(name)[0]}.json")
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)

        row = {"file": name, "elapsedSeconds": result["elapsedSeconds"], **summarize(result)}
        summary_rows.append(row)
        print("=" * 78)
        print(f"{name} | {row['elapsedSeconds']}s | turn {row['turn']} {row['reason']} | {row['sessionId']}")
        for draft in row["drafts"]:
            print(f"--- reply_draft (turn {draft['turn']}, risk={draft['riskLevel']}) ---")
            print(draft["body"])
        if not row["drafts"]:
            print("（本轮没有 reply_draft；assistantText）")
            print(row["assistantText"])
        print()

    summary_path = os.path.join(args.out, "summary.json")
    with open(summary_path, "w", encoding="utf-8") as handle:
        json.dump(summary_rows, handle, ensure_ascii=False, indent=2)
    print(f"摘要：{summary_path}")
    return 0 if all("error" not in row for row in summary_rows) else 2


if __name__ == "__main__":
    raise SystemExit(main())
