# 会话内容存档：接入说明

> 本目录原先**不预置可运行代码**（没有密钥和已开通账号时，“能跑”的代码都是假的）。
> 存档已开通并实测通过后，补上了 `archive_dump.cpp`：一个最小可用的拉取 + 解密工具。

## 它是外部客户群读消息的唯一官方路径

- 自建应用没有读取客户群消息的接口。
- 群机器人不能进外部群。
- 唯一来源：会话内容存档（SDK 拉取）。

## 前提（按顺序）

| # | 条件 | 说明 |
|---|---|---|
| 1 | 企业已认证 | 未认证主体无法开通 |
| 2 | 超级管理员操作 | 或授权的分级管理员 |
| 3 | 购买 / 试用 | 后台「管理工具 → 会话内容存档」 |
| 4 | 盖章确认函 | 上传后审核约 1–3 个工作日 |
| 5 | 配置存档成员范围 | 决定哪些员工的消息被存档 |
| 6 | IP 白名单 | 调用方出口 IP |
| 7 | RSA 公私钥 | 私钥自己保管，公钥配置到后台 |
| 8 | 员工告知 + 外部联系人同意 | 客户不同意则不入档 |

## 需要准备的材料

```
WECOM_CORP_ID
WECOM_ARCHIVE_SECRET
config/archive_private_key.pem
官方 SDK（Linux .so / Windows .dll / Java JNI）
```

放到 `.env.local` 与 `config/`，两者都已被 `.gitignore` 忽略。

## 官方调用流程（C / Java SDK）

```
NewSdk()
  → Init(sdk, corpId, secret)                                       // 不带私钥
  → GetChatData(sdk, seq, limit, proxy, passwd, timeout, chatData)   // limit ≤ 1000
  → RSA 私钥解 chatData[i].encrypt_random_key（PKCS#1 v1.5）
  → DecryptData(encrypt_key, chatData[i].encrypt_chat_msg, &msg)
  → GetMediaData(sdk, sdkfileid, indexbuf, ...)                     // 每次 ≤ 512K
```

> 已在真实环境验证（2026-11-08，见 `docs/C2-0-verification-log.md`）：`Init` 只有 corpId/secret 三个参数；
> `encrypt_random_key` 是标准 Base64，需先用 RSA 私钥按 PKCS#1 v1.5 解出对称密钥，再交给 `DecryptData`。

- `seq` 首次传 0，之后传上次返回的最大 `seq`。
- 拉取记录频率 ≤ 4000 次/分钟；媒体 ≤ 25000 次/分钟。
- **记录只能取最近 5 天**，必须定期拉取落库，否则丢失。
- 群聊消息用 `roomid` 标识群，单聊为空。

## 解密后的关键字段

```json
{
  "msgid": "...",
  "action": "send",
  "from": "wmXXXX",
  "tolist": ["..."],
  "roomid": "...",
  "msgtime": 1730000000000,
  "msgtype": "text | image | file | ..."
}
```

图片/文件：取 `sdkfileid`，再调 `GetMediaData` 分片拉取，用 `outindexbuf` 续传，`is_finished` 判断结束。

## 边界（别指望它）

| 想做的事 | 存档能给吗 |
|---|---|
| 读外部群文字/图片/文件 | ✅ |
| 读 5 天前历史 | ❌ |
| 读开通前记录 | ❌ |
| 让机器人回复 | ❌ 存档只读 |
| 读机器人的聊天记录 | ❌ 官方明确不支持 |

## 已实现的最小工具：`archive_dump.cpp`

拉取 → RSA 解密 → `DecryptData` → 打印明文，供 `src/c2/adapters/wecom-archive.ts` 调用。

```bash
sudo apt install -y g++ libssl-dev
# 与 WeWorkFinanceSdk_C.h、libWeWorkFinanceSdk_C.so 同目录
g++ -O2 -std=c++17 archive_dump.cpp -o archive_dump \
    -L. -lWeWorkFinanceSdk_C -ldl -lcrypto -Wl,-rpath,'$ORIGIN'

./archive_dump 0 100 ./private_key.pem config.txt          # 人工看
./archive_dump --json 0 100 ./private_key.pem config.txt   # 输出 {"nextSeq":N,"count":N,"messages":[...]}
```

要点：

- 直接调用（非 `dlopen`）必须带 `-L. -lWeWorkFinanceSdk_C`，否则链接报 `undefined reference to NewSdk`。
- `NewSdk()` 返回 `void*`，其余接口要 `WeWorkFinanceSdk_t*`，需显式转换。
- `publickey_ver` 是数字；换了后台公钥后，旧版本号的消息解不开，工具会跳过并推进 `seq`。
- `--json` 模式 stdout 只有一行 JSON，日志/错误走 stderr。

## 最小验证顺序

1. 拉 100 条，打印 `msgtype` 分布。
2. 找到测试群那条消息，核对 `roomid` 与客户群详情里的 `chat_id`。
3. 拉一张图片，确认 `sdkfileid` 与文件大小。
4. 隔 6 天再拉同一时段，确认时间窗限制。

## 参考

- 概述：https://developer.work.weixin.qq.com/document/path/91360
- 获取会话内容：https://developer.work.weixin.qq.com/document/path/91774
