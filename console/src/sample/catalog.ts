export const SOLUTION_BLURBS: Record<string, string> = {
  spk_weight_metabolism: '围绕体重、体脂与代谢指标，提供饮食、运动与随访话术的组合方案。',
  spk_chronic_followup: '面向慢病人群的定期随访、指标关注与复诊提醒方案。',
  spk_postpartum: '产后恢复阶段的作息、饮食与情绪支持方案。',
  spk_aesthetic_aftercare: '医美术后护理期的注意事项、复诊与回访方案。',
  spk_tcm: '中医调理方向的起居、饮食与复诊提醒方案，不涉及诊断与用药调整。',
};

export function solutionBlurb(id: string, fallback: string): string {
  return SOLUTION_BLURBS[id] || fallback;
}
