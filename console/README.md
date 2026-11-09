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

演示数据全部来自 `src/mock/fixtures/`（虚构数据），页面右上角 `MOCK` 标签表示当前未连接真实接口。

## 切换真实接口

```bash
VITE_API_MODE=real npm run dev
```

- `VITE_API_BASE` 可覆盖接口前缀，默认 `/zhiban/api`。
- 真实模式使用 cookie 会话，调用 `POST /auth/login`、`GET /auth/session`、`GET/PATCH /tenant`，契约见 [docs/P1-api.md](../docs/P1-api.md)。
- 不提交任何凭据；不要把真实账号写进代码或 fixtures。

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
