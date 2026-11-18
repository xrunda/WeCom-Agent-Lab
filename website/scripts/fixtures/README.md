# 企微 / 微信界面示意

这不是真实企业微信或微信客户端的截图。

在真实企微 1:1 对话截图尚未录制前，用同一组虚构演示数据（林女士 / 陈顾问 / 示例健康服务群）重建了界面的结构与文案，用于官网说明流程。对应图注统一写「企微界面示意 · 演示数据」或「微信场景示意」。

## 生成方式

用浏览器直接打开：

```text
scripts/fixtures/wecom-scenes.html?scene=reminder
scripts/fixtures/wecom-scenes.html?scene=qa-feedback
scripts/fixtures/wecom-scenes.html?scene=qa-photo
scripts/fixtures/wecom-scenes.html?scene=group-log
scripts/fixtures/wecom-scenes.html?scene=group-reply
```

在 390×844 视口、3× 像素密度下截图，再输出到 `public/assets/screens/`。

## 待替换

真实企微提醒、问答、餐食照片截图需要真机录制。拿到后：

1. 替换 `public/assets/screens/wecom-*.png`、`hero-reminder.png`、`reminder-card.png`、`qa-*-card.png` 等对应文件
2. 删除本目录
3. 在 PR / README 中把「界面示意」改成真机截图说明

餐食照片来自控制台沙盒示例素材，均为虚构演示数据。
