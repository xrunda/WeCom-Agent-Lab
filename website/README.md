# 知伴健康产品官网（V1）

面向健康服务机构负责人、运营主管和顾问主管的两级六页官网。独立于业务控制台构建与部署，不引入控制台 UI 运行时。

## 路由

| 路由 | 页面 |
|---|---|
| `/` | 首页 |
| `/customer-agent` | 客户专属助手 |
| `/advisor` | 顾问工作台 |
| `/management` | 机构管理 |
| `/scenarios` | 业务场景 |
| `/demo` | 预约演示 |
| 其他 | 404（可返回首页） |

## 本地运行

```bash
cd website
npm ci
npm run dev                 # 前端 http://127.0.0.1:5180
```

另开一个终端启动预约接收端（开发代理默认指向 8080）：

```bash
cd website
WEBSITE_ADMIN_TOKEN="$(openssl rand -hex 24)" \
WEBSITE_STORE_DIR=/tmp/zhiban-website-store \
npm run serve               # API + dist 静态文件
```

开发时 `npm run dev` 会把 `/api` 代理到 `WEBSITE_API_TARGET`（默认 `http://127.0.0.1:8080`）。

## 构建与预览

```bash
cd website
npm run build
WEBSITE_ADMIN_TOKEN="$(cat /tmp/website-admin-token)" \
WEBSITE_STORE_DIR=/tmp/zhiban-website-store \
npm run serve               # http://127.0.0.1:8080
```

检查与测试：

```bash
npm run typecheck
npm test                    # 前端校验测试 + 预约接收端测试
```

## 预约接收端

- 入口：`POST /api/demo-requests`
- 字段：`orgName`、`contactName`、`contact`（手机 / 邮箱 / 微信号）、`topic`（选填）
- 成功：`200 {ok:true,id}`；缺项：`400` 并返回 `error.fields`；限流：`429`；服务端失败：`500`
- 持久化：`WEBSITE_STORE_DIR/demo-requests.jsonl`，目录 `0700`、文件 `0600`
- 查看线索：`GET /api/demo-requests`，请求头 `Authorization: Bearer $WEBSITE_ADMIN_TOKEN`
  - 未配置令牌（为空或少于 24 个字符）返回 `503`
  - 令牌不匹配返回 `401`
  - 响应不回显原始表单指纹；联系方式仅供授权人员查看
- 基础防刷：单 IP 每小时 5 次、蜜罐字段、10 分钟内相同联系方式的重复提交返回同一条记录
- 日志只记方法、路径、状态码、耗时和记录 id，不记表单内容

本地验证记录（2026-11-18）：

- 缺项：机构名称 / 联系人 / 联系方式分别返回字段错误
- 成功：提交后可从接收端查到，联系方式允许手机、邮箱、微信号
- 失败重试：模拟网络失败显示「预约暂未提交成功，请稍后重试。」，输入保留；恢复后重试成功
- 重复提交：同一联系方式在 10 分钟窗口内返回同一条记录
- 权限：目录 `drwx------`、文件 `-rw-------`；日志无联系方式和机构名

## 环境变量

见 [.env.example](.env.example)。不要提交真实令牌或线索文件。

部署在 nginx 等反向代理后时设 `WEBSITE_TRUST_PROXY=1`，按 `X-Forwarded-For` 首个地址做单 IP 限流；直连时保持默认 `0`。

生产域名确定后再生成 canonical 与 sitemap：

```bash
VITE_SITE_ORIGIN=https://example.com VITE_ALLOW_INDEX=1 npm run build
VITE_SITE_ORIGIN=https://example.com npm run sitemap
```

预览版本 `index.html` 与页面运行时均保持 `noindex,nofollow`。

## 素材说明

- 品牌资产：`docs/Images/VI/zhiban_logo.png`（透明原色 / 反白 / 心形三种派生版本），保留比例与留白
- 产品界面截图：在控制台 mock 模式下用同一组演示数据（林女士 / 陈顾问 / 示例健康服务群）截取，图注「产品界面 · 演示数据」
- 企微与微信对话截图：同一组演示数据下的界面示意，图注「企微界面示意 / 微信场景示意 · 演示数据」；**真实企微 1:1 截图仍待真机录制**
- 产品演示视频：`docs/Images/videos/2026-11-16/知伴健康-个人Agent与主动协作-720p.mp4`，中文字幕由同目录 SRT 转 VTT
- 视频为公开通用版，视频内使用「张女士 / 刘先生」；官网文案统一使用「林女士 / 陈顾问」

## 待项目负责人处理

- 真实企微 1:1 提醒、问答、餐食照片截图需要真机录制后替换当前界面示意
- 正式域名、HTTPS、预览是否允许索引
- 线上预约接收端的 `WEBSITE_ADMIN_TOKEN` 与持久化目录
- 官网与预览环境的部署位置
