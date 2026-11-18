# 知伴健康产品官网（V1）

面向健康服务机构负责人、运营主管和顾问主管的两级六页官网（含 `/pricing`）；旧 `/demo` 链接保留并直接跳转企微。独立于业务控制台构建与部署，不引入控制台 UI 运行时。

## 路由

| 路由 | 页面 |
|---|---|
| `/` | 首页 |
| `/customer-agent` | 客户专属助手 |
| `/advisor` | 顾问工作台 |
| `/management` | 机构管理 |
| `/scenarios` | 业务场景 |
| `/pricing` | 产品定价：种子合作参考价、方案范围、企微存档费、FAQ |
| `/demo` | 旧预约入口：直接重定向到企微获客链接 |
| 其他 | 404（可返回首页） |

## 本地运行

```bash
cd website
npm ci
npm run dev                 # http://127.0.0.1:5180
```

构建与预览：

```bash
npm run build
npm run preview -- --port 8080   # http://127.0.0.1:8080
```

检查与测试：

```bash
npm run typecheck
npm test                    # Vitest
```

## 预约入口

全站所有「预约演示」按钮直接打开企业微信「联系我」获客链接，不再经过站内表单或中转页：

- 链接：`https://work.weixin.qq.com/ca/cawcded818a8d398cf`
- 页头、页尾、首页、机构管理页的预约入口均为外链，`target="_blank"` + `noopener`
- 旧 `/demo` 地址保留：打开后直接 `location.replace` 到企微获客页，作为兜底
- 访客添加顾问企业微信后由顾问本人对接，官网不留存联系方式

更换获客链接时，只需更新 `src/site.ts` 的 `WECOM_CONTACT_URL`。

## 定价页口径

- 平台服务费与企微会话存档费分开列，不合并成一个总价。
- 平台价显示「种子合作参考价」**¥19,800 / 月**，**含 10 个顾问席位**；控制台管理员账号不占席位、不单独计费。价格卡同时注明：使用客户群服务还需为每位顾问单独购买企微会话存档。公开生产站发布前，金额需项目负责人确认；若届时不能公示，价格区改为「按方案报价」，其余模块不变。
- 企微存档费参考 900 元 / 人 / 年，由机构直接付给企业微信，**是使用客户群服务的前置条件**：未开通存档的顾问无法使用知伴；金额旁保留「参考」字样，不写成「示例金额」。
- 不写统一标价、折扣、年付金额、超额单价、医疗效果、无限用量、定制交付或服务等级承诺。
- 报价依据：`docs/P1-multi-advisor.md` §12、`docs/M1-purchase-decision.md`、PRD §8。

## 给 AI Agent 的入口

官网提供两份机器可读文件，方便客户直接让 Agent 读官网：

- `/llms.txt`：按 [llmstxt.org](https://llmstxt.org) 约定写的项目介绍——定位、能力、计费口径、边界、六个页面链接、预约方式。由 `src/llms.ts` 生成，价格与席位数取自 `src/plan.ts`，与定价页同源。
- `/robots.txt`：允许抓取并指向 `sitemap.xml`。
- 另在 `index.html` 里放了 `SoftwareApplication` 的 JSON-LD 结构化数据，以及指向 `llms.txt` 的 `rel="alternate"` 链接。

两份文件在 `npm run build` 前由 `prebuild` 自动生成；单独执行 `npm run llms` 也可以。默认写入生产域名 `https://zhiban.xrunda.com`，换域名时用 `VITE_SITE_ORIGIN` 覆盖。

## 环境变量

见 [.env.example](.env.example)。生产域名确定后再生成 canonical 与 sitemap：

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
- 官网预览与生产部署位置
