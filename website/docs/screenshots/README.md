# 六页截图

2026-11-18 生成。桌面 1440px、移动 390px；整页截图，用于 PR 与验收比对。

| 页面 | 1440 | 390 |
|---|---|---|
| 首页 | `home-1440.jpg` | `home-390.jpg` |
| 客户专属助手 | `customer-agent-1440.jpg` | `customer-agent-390.jpg` |
| 顾问工作台 | `advisor-1440.jpg` | `advisor-390.jpg` |
| 机构管理 | `management-1440.jpg` | `management-390.jpg` |
| 业务场景 | `scenarios-1440.jpg` | `scenarios-390.jpg` |
| 预约演示 | `demo-1440.jpg` | `demo-390.jpg` |

生成环境：本地 `npm run build` + `npm run serve`，产品截图来自控制台 mock 模式，企微 / 微信截图为界面示意。截图内数据均为虚构演示数据。

横向溢出检查：360 / 768 / 1440 三档，六个路由均无页面级横向溢出（`scrollWidth - innerWidth = 0`）。
