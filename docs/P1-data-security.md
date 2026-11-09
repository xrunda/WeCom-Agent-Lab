# 数据与安全页 / 证据链导出（#59）实现说明

> 归属工作包：WP-M（#59 数据与安全页 + 证据链导出 PDF）
> 契约依据：[P1-api.md](./P1-api.md)（`GET /settings/security`、`GET /drafts/{id}/evidence.pdf`、`GET /patients/{id}/records.pdf`）
> 控制台框架：[P1-console-backend.md](./P1-console-backend.md)

本文只描述**已实现范围**与**本地验收**；需要部署机、企微后台或真实存档数据的验收项单独标「⏳ 待真机」。

---

## 1. 范围

| 能力 | 实现 |
|---|---|
| 数据与安全页 | 部署事实（数据区域、模型服务与运行区域、传输加密、数据存储）、留存口径、患者存档同意统计、访问角色、近 30 天审计/导出计数、PDF 字体状态 |
| 单条证据链 PDF | 客户原话（含图片缩略图）、全部草稿版本与改稿要求、实发正文、存档 msgid 与时间、核验结果、引用与操作人；页脚导出人与生成时间；写审计 `evidence.export` |
| 患者服务记录 PDF | 按患者与时间范围导出（默认最近 30 天，单次最多 200 条并标注截断）；写审计 `records.export` |
| 权限 | `admin` / `supervisor` 可导出；`viewer` 后端 `403 FORBIDDEN`，前端不显示导出入口 |
| 前端 | `/settings/security` 页面；服务流草稿详情「导出证据链 PDF」；患者 Agent「导出服务记录」（可选日期范围） |

不在本包范围：真实企微存档的联调、PDF 数字签名/骑缝章、按合同自动清理数据（P1 明确不自动删除）。

## 2. 代码位置

```text
src/p1/
  security.ts        数据与安全页口径（纯函数，可单测）
  evidence.ts        证据链 / 服务记录装配（取数、校验、排序、截断）
plugins/zhiban-console/
  pdf.ts             服务端 PDF 渲染（pdfkit + 部署机中文字体）
  index.ts           路由：/settings/security、/drafts/:id/evidence.pdf、/patients/:id/records.pdf
  config.ts          deployment / pdf 配置项
plugins/zhiban-wecom/
  index.ts           zhibanWecomAdmin 新增 getDraftEvidence / listDraftsByRooms（只读）
plugins/zhiban-patient/
  index.ts           zhibanPatient 新增 getPatientGroups / consentStats（只读）
console/src/
  pages/settings/security/index.tsx   数据与安全页
  mock/security.ts                    mock 口径（演示数据明确标注）
  mock/exports.ts                     真实模式下载；mock 模式明确报 MOCK_ONLY
  utils/permissions.ts                账号页与数据安全页共用的权限矩阵
```

## 3. 数据来源与口径

| 页面/PDF 内容 | 来源 | 备注 |
|---|---|---|
| 数据区域、模型服务、模型运行区域 | `zhiban-console` 配置 `deployment.*` | 不填时默认「中国大陆境内 / DeepSeek（境内）」；页面不写死 |
| 传输加密 | `cookieSecure` | `true` → HTTPS（Secure Cookie）；`false` → 明确标注「仅本地调试」 |
| 数据存储 | `sandbox.mediaRootDir` 与实际存储 | 领域存储、沙盒/图片、企微会话存档 |
| 留存口径 | `tenant.settings.retentionNotice` | P1 `autoDelete: false`，与实现一致 |
| 同意统计 | `zhibanPatient.consentStats()` | 跳过已删除患者；插件未就绪时返回 `null` |
| 审计/导出计数 | 控制台审计表最近 30 天 | 导出动作：`evidence.export` / `records.export` / `audit.export` |
| 草稿版本、核验、实发 | C2 领域存储（`zhibanWecomAdmin`） | 只读投影；不复制消息正文到控制台存储 |
| 客户原话与图片 | 企微会话存档（`ArchivePort.listGroupMessages`，向后兼容 `listInboundMessages`） | 草稿创建前后各 30 分钟窗口；存档不可用时 PDF 标注「未取到存档原文」并回退为核验版本正文 |

### 3.1 证据链 PDF 的页面结构

1. 头部：机构名 · 服务证据链；草稿编号、患者/客户、服务群、顾问、风险等级、草稿状态、创建/推送时间、导出人与导出时间。
2. 客户原话：存档原文（按时间正序），图片消息按本机 `mediaPath` 嵌入缩略图。
3. 草稿版本：每一版的生成者（Agent/顾问）、时间、改稿要求与正文；标注核验对应的发送版本。
4. 实发与核验：核验结果、核验时间、存档 msgid、匹配群、相似度、实发时间与正文、顾问操作。
5. 引用与操作人：引用的记忆 / 知识 id 与顾问。
6. 页脚（每页）：`第 X / Y 页 · 导出人 · 生成时间`。

### 3.2 服务记录 PDF

- 默认窗口：最近 30 天；`from` / `to` 支持毫秒时间戳或 ISO 8601，`from >= to` 返回 `422`。
- 只取患者绑定服务群的草稿，按 `createdAt` 倒序；超过 200 条截断，PDF 中标注「已截断」。
- 每条记录包含时间、群、状态、草稿编号、核验结果与正文。

## 4. 部署配置

在 `zhiban-console` 插件配置中新增（均可选）：

```json
{
  "deployment": {
    "region": "中国大陆境内",
    "modelRegion": "中国大陆境内",
    "modelService": "DeepSeek（境内）"
  },
  "pdf": {
    "fontPath": "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "fontFamily": "NotoSansCJKsc-Regular"
  }
}
```

- **仓库不打包字体**（许可证与体积原因）。找不到字体时导出返回 `502 UPSTREAM_UNAVAILABLE`，启动日志提示安装 `fonts-noto-cjk` 或配置 `pdf.fontPath`。
- 字体查找顺序：`pdf.fontPath` → 环境变量 `ZHIBAN_PDF_FONT` / `ZHIBAN_PDF_FONT_FAMILY` → 常见系统路径（macOS 宋体/黑体、Linux Noto CJK / 文泉驿）。
- `.ttc` 字体集合必须同时给出集合内的 PostScript 名（如宋体 `STSong`、Noto `NotoSansCJKsc-Regular`）；只给文件路径会报「Not a supported font format」。
- Debian/Ubuntu 推荐：`apt-get install -y fonts-noto-cjk`；容器镜像需在构建阶段安装。

前端：真实模式通过 `fetch` 下载 PDF（`credentials: include`，读取 `content-disposition` 文件名）；mock 模式无法生成带中文字体的 PDF，页面明确提示「演示模式不生成 PDF」，**不伪造下载成功**。

## 5. 本地验收（已执行）

环境：macOS，Node ≥ 22.6，离线；未连接真实企微、未使用真实患者数据。

```bash
npx tsc --noEmit          # 通过
npm test                  # 254/254 通过（2026-11-10，本地）
cd console
npx tsc --noEmit          # 通过
npx vitest run            # 100/100 通过
```

| 验收点 | 覆盖测试 | 结果 |
|---|---|---|
| 数据安全页字段、留存口径、同意统计、角色矩阵 | `tests/evidence.test.ts`、`tests/console-plugin.test.ts` | ✅（mock/假端口，非真机） |
| 近 30 天事件/导出计数、最近导出时间 | `tests/evidence.test.ts` | ✅ |
| 证据链装配：缺失 id / 插件未就绪 / 草稿不存在 | `tests/evidence.test.ts` | ✅ |
| 服务记录：默认 30 天、倒序、按群过滤、时间校验、200 条截断 | `tests/evidence.test.ts` | ✅ |
| PDF 渲染（真实系统中文字体）与缺少字体时的 502 | `tests/evidence.test.ts`、`tests/console-plugin.test.ts` | ✅（本机字体） |
| 路由权限：未登录 401、viewer 403、导出审计、文件名、404/422/502 | `tests/console-plugin.test.ts` | ✅ |
| 前端页面与导出交互（含演示模式提示） | `console/tests/m-pages.test.tsx`、`console/tests/m-mocks.test.ts` | ✅（mock 数据） |

本机用虚构数据渲染的证据链 PDF 已用 `pdftotext` 人工核对，包含：客户原话「晚上能吃海鲜吗？」、两版草稿、改稿要求「加上忌口提醒」、`（本版本为核验对应的发送版本）`、核验结果「核验通过（照原文发送）」、存档 msgid、实发正文、顾问操作、页脚「第 1 / 1 页 · 导出人 · 生成时间」。**该结果只证明本地渲染可用，不替代真实存档数据的验收。**

## 6. ⏳ 待真机验收

> 以下项目未在真实部署执行，**不能视为已通过**。请在部署环境按步骤验证并把结果补回 PR/Issue。

| # | 项目 | 步骤 | 期望 |
|---|---|---|---|
| E1 | 部署机中文字体 | 在目标主机执行导出；再移除字体/改错 `pdf.fontPath` 重试 | 有字体时下载 PDF 且中文正常；无字体时返回 502，日志提示安装字体或配置路径 |
| E2 | 真实证据链 | 选一条真实 `VERIFIED` / `EDIT_SENT` 草稿导出 | PDF 的客户原话、各版正文、实发正文、msgid、时间与企微后台/审计一致；图片消息有缩略图 |
| E3 | 存档不可用降级 | 临时停掉存档 SDK 后导出 | 仍生成 PDF，客户原话处标注「未取到存档原文」，实发段落回退为核验版本正文 |
| E4 | 患者服务记录 | 选有绑定群的真实患者，默认范围导出；再指定日期范围 | 记录条数与群过滤正确；超过 200 条时标注截断；无绑定群时 PDF 显示「未绑定」 |
| E5 | 权限与审计 | 分别用 admin / supervisor / viewer 导出 | 前两者成功且审计出现 `evidence.export` / `records.export`；viewer 返回 403 且无审计成功记录 |
| E6 | HTTPS 下载 | 在 HTTPS 控制台点击导出 | 浏览器带 Cookie 下载，文件名正确；`cache-control: no-store` 生效；不被反向代理缓冲/改写 |
| E7 | 大数据量 | 用接近 200 条的草稿量导出 | 响应时间与 PDF 体积可接受；服务内存无异常增长 |

## 7. 安全与合规自查

- 导出接口只读，不修改草稿、核验或患者状态；审计只记录导出人、目标、字节数与记录数，**不记录正文**。
- 日志不打印消息正文；PDF 内容只写入响应，不落地到控制台存储。
- 患者服务记录只取该患者绑定服务群的草稿，不会跨患者泄漏。
- 测试、示例数据全部虚构；客户名未出现在代码、界面与示例数据中（检查规则见 [DEV-GUIDE](./DEV-GUIDE.md)）。
- 任何「机器人 / Agent 自动发到客户群」的设计均未引入；导出只面向控制台会话。
