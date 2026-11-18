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

`/demo` 不再收集表单，改为企业微信「联系我」获客链接：

- 链接：`https://work.weixin.qq.com/ca/cawcded818a8d398cf`
- 页面展示对应二维码 + 「打开企业微信，联系顾问」按钮
- 手机端点击按钮直接打开企业微信；电脑端可用微信或企业微信扫码
- 访客添加顾问企业微信后由顾问本人对接，官网不留存联系方式
- 二维码文件：`public/assets/brand/wecom-contact-qr.png`

更换获客链接时，需要同时更新 `src/pages/DemoPage.tsx` 的 `WECOM_CONTACT_URL` 和二维码图片。

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
