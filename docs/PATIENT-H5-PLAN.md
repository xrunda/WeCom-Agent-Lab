# 患者端 H5：里程碑与工作包

> 2026-11-24 创建 · 2026-11-25 更新状态：规划已创建；PH5-01～PH5-03 已提交实现 PR（#243/#244/#245，待评审），PH5-04 起未开始。本文只记规划，实施进度以对应 PR 与 issue 为准。
> 依据：[患者端 H5 PRD](PATIENT-H5-PRD.md) · [产品顶层定义](PRODUCT-FOUNDATION.md)
> 总任务：[患者端 H5 Epic #228](https://github.com/xrunda/WeCom-Agent-Lab/issues/228)
> 视觉参考：[效果图索引](design/patient-h5/README.md) · [素材清单与交付规范](design/patient-h5/ASSET-INVENTORY.md)

## 里程碑

- [PH5-M0 范围确认与契约](https://github.com/xrunda/WeCom-Agent-Lab/milestone/10)：2 个工作包。
- [PH5-M1 个人计划与健康日历](https://github.com/xrunda/WeCom-Agent-Lab/milestone/11)：4 个工作包。
- [PH5-M2 日常记录与持续服务](https://github.com/xrunda/WeCom-Agent-Lab/milestone/12)：5 个工作包。
- [PH5-M3 真机验收与试点验证](https://github.com/xrunda/WeCom-Agent-Lab/milestone/13)：2 个工作包。

不设截止日期；12月4日展示范围须另行决定，不承诺全部上线。

## 工作包与依赖

| 工作包 | Issue | 内容 | 阶段 | 硬性前置 |
|---|---|---|---|---|
| PH5-00 | [#229](https://github.com/xrunda/WeCom-Agent-Lab/issues/229) | 范围与真实试点资源闸门 | M0 | — |
| PH5-01 | [#230](https://github.com/xrunda/WeCom-Agent-Lab/issues/230) | 患者领域模型、独立 API 与权限契约 | M0 | — |
| PH5-02 | [#231](https://github.com/xrunda/WeCom-Agent-Lab/issues/231) | 邀请核验、患者会话、授权与安全访问 | M1 | #230 |
| PH5-03 | [#232](https://github.com/xrunda/WeCom-Agent-Lab/issues/232) | H5 页面骨架、食养主张与轻量建档 | M1 | #230 |
| PH5-04 | [#233](https://github.com/xrunda/WeCom-Agent-Lab/issues/233) | AI 个性化计划与专业审核发布、版本变更 | M1 | #230 |
| PH5-05 | [#234](https://github.com/xrunda/WeCom-Agent-Lab/issues/234) | 今日首页、健康周历与行动反馈 | M1 | #231、#232、#233 |
| PH5-06 | [#235](https://github.com/xrunda/WeCom-Agent-Lab/issues/235) | 餐食拍照识别、确认记录与晚间回顾 | M2 | #231、#232 |
| PH5-07 | [#236](https://github.com/xrunda/WeCom-Agent-Lab/issues/236) | 专业团队联系、反馈认领与超时升级 | M2 | #231、#230 |
| PH5-08 | [#237](https://github.com/xrunda/WeCom-Agent-Lab/issues/237) | 食养文化内容库、审核发布与计划关联 | M2 | #230、#232 |
| PH5-09 | [#238](https://github.com/xrunda/WeCom-Agent-Lab/issues/238) | 主动提醒、频控、取消与企微触达衔接 | M2 | #231、#233、#236 |
| PH5-10 | [#239](https://github.com/xrunda/WeCom-Agent-Lab/issues/239) | 个人中心、档案纠错、记录历史与提醒偏好 | M2 | #231、#232、#233、#235、#236 |
| PH5-11 | [#240](https://github.com/xrunda/WeCom-Agent-Lab/issues/240) | 部署、隐私埋点、端到端与微信真机验收 | M3 | #229、#231、#232、#233、#234、#235、#236、#237、#238、#239 |
| PH5-12 | [#241](https://github.com/xrunda/WeCom-Agent-Lab/issues/241) | 小规模可用性观察与真实试点复盘 | M3 | #229、#240 |

每个 issue 都有范围、不做、验收与交付。PH5-00 是真实试点资源闸门，可与契约和虚构数据开发并行；其未关闭前不接入真实试点。契约冻结后可按依赖开展前后台工作；未完成后端依赖时前端只能使用明确标记的虚构数据。

## 执行约定

- 一个工作包一个独立分支/PR，建议 `codex/ph5-<编号>`，不合并、不推 main。
- 未分配人员，不把创建任务视为已认领或已完成。
- 项目方资源类任务标记 `needs-user`，涉及微信/服务器验证的任务标记 `needs-device`。
- 本地/模拟渠道/微信真机分别记录；关键流程验收通过、资源就绪之后才能真实试点。
- 不改写既有任务状态；原 `ISSUES.md` 仍由项目负责人维护，本索引专门承载新增患者端范围。
- #212 年龄/性别字段、#170 存档同意问题与现有侧边栏能力均是相关工作，不据此重复认领或修改其范围；实施前核对已有实现。

