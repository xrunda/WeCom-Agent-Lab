# 知伴健康 Agent 控制台（P1）

Vite + React 18 + TypeScript + Ant Design 5 + ProComponents 的控制台骨架。本目录由 WP-I（#42）建立，业务页面由后续工作包填充。

## 本地运行

```bash
cd console
npm install
npm run dev        # http://127.0.0.1:5173，/zhiban/api 代理到 127.0.0.1:3080
```

mock 模式默认开启，演示账号：

| 用户名 | 密码 | 角色 |
|---|---|---|
| `admin` | `zhiban-demo` | 机构管理员 |
| `supervisor` | `zhiban-demo` | 主管 |
| `viewer` | `zhiban-demo` | 只读 |

演示数据全部来自 `src/mock/fixtures/` 与 `src/sample/`（虚构数据）。mock 模式页面顶部有「示例数据」横幅，右上角显示 `MOCK` 标签。

## 切换真实接口

```bash
# 部署机的控制台 API 只监听 127.0.0.1，需要先建立 SSH 隧道
ssh -N -L 3080:127.0.0.1:3080 <部署机账号>@<部署机地址>

npm run dev:real   # 等价于 VITE_API_MODE=real npm run dev
```

- `VITE_API_BASE` 可覆盖接口前缀，默认 `/zhiban/api`。
- 真实模式使用 cookie 会话；登录契约见 [docs/P1-api.md](../docs/P1-api.md) §2。
- 真实模式下，未接入后端的模块显示「未接入」，**不会回退到示例数据**；页面顶部显示 `LIVE 真实接口`。
- 不提交任何凭据；不要把真实账号写进代码或 fixtures。

### 真实模式的数据范围（P1）

| 模块 | 数据来源 |
|---|---|
| 工作台 | 价值条、KPI、趋势与排行为真实草稿统计；**团队关注**由未解决告警、草稿、患者、顾问与群绑定读时派生 |
| 患者、服务群、顾问、实时服务流、质检与告警 | 真实 DSH 存储与企微会话存档 |
| 体验中心（沙盒） | 真实 Agent / 模型回合，独立存储，不计入运营统计 |
| 系统设置：Agent 设定、账号与角色、审计日志、数据与安全 | 真实租户 / 账号 / 审计 |
| 数据报表 | 尚未接入真实统计，显示「未接入」 |
| 知识库、风险规则、话术库 | 真实 DSH 存储与审计 |
| 技能市场、行业方案包 | 尚未接入，显示「未接入」 |
| 企微接入状态、AI 模型、开通正式服务 | 尚未接入，显示「未接入」 |
| 患者详情：慢病管理（原「健康档案」） | 真实结构化档案；顾问手工录入，Agent 从对话中提取体征 |
| 患者详情：服务计划 | P1 无真实数据，显示「尚未接入」 |
| 健康打卡、排班与交接 | 即将上线（C 档介绍页） |

## 校验

```bash
npm test           # Vitest + Testing Library
npm run typecheck
npm run build
```

## 目录

```
src/
  auth/         登录态、称谓与租户设置
  layout/       ProLayout 外壳、菜单、称谓切换
  mock/         mock API 与 fixtures
  components/   SampleDataTag、ComingSoonPage、PagePlaceholder
  pages/        各路由页面（WP-I 为占位页）
tests/          mock API、菜单、通用组件、外壳测试
```

## 范围说明

- WP-I 只负责外壳：登录、菜单、品牌、称谓、C 档介绍页与占位路由。
- C 档页面（健康打卡、排班与交接）使用统一的 `ComingSoonPage`。
- 菜单与页面标题中的称谓取自租户设置，默认「患者」，可切换为「客户」「会员」。
