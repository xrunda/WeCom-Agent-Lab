/** C 档技能 / 方案包介绍文案（虚构示例，仅用于控制台展示）。 */
export const SKILL_BLURBS: Record<string, string> = {
  'skl_report-reading': '识别体检与化验指标，提示复诊与生活方式关注点，不替代医生诊断。',
  skl_appointment: '按计划提醒复诊与检查，减少爽约，提醒记录进入服务流。',
  skl_device: '接入血糖、血压等设备数据，在服务流中呈现趋势，异常时提示顾问跟进。',
  skl_miniapp: '在合规与授权前提下提供服务入口，不绕过企微服务群。',
};

export const SOLUTION_BLURBS: Record<string, string> = {
  spk_weight_metabolism: '围绕体重、体脂与代谢指标，提供饮食、运动与随访话术的组合方案。',
  spk_chronic_followup: '面向慢病人群的定期随访、指标关注与复诊提醒方案。',
  spk_postpartum: '产后恢复阶段的作息、饮食与情绪支持方案。',
  spk_aesthetic_aftercare: '医美术后护理期的注意事项、复诊与回访方案。',
  spk_tcm: '中医调理方向的起居、饮食与复诊提醒方案，不涉及诊断与用药调整。',
};

export function skillBlurb(id: string, fallback: string): string {
  return SKILL_BLURBS[id] || fallback;
}

export function solutionBlurb(id: string, fallback: string): string {
  return SOLUTION_BLURBS[id] || fallback;
}
