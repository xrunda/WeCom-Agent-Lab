import skillsFixture from './fixtures/skills.json';
import solutionsFixture from './fixtures/solution-packs.json';
import { apiRequest, isMockMode } from './http.ts';
import type { Skill, SolutionPack } from '../types.ts';

export interface SkillList {
  installed: Skill[];
  upcoming: Skill[];
}

/** GET /skills：真实模式下 installed 来自 DSH 插件清单 */
export async function listSkills(): Promise<SkillList> {
  if (!isMockMode) return apiRequest('/skills');
  return skillsFixture as unknown as SkillList;
}

/** GET /solution-packs */
export async function listSolutionPacks(): Promise<{ items: SolutionPack[]; total: number }> {
  if (!isMockMode) return apiRequest('/solution-packs');
  const items = solutionsFixture as unknown as SolutionPack[];
  return { items, total: items.length };
}

export async function getSkill(id: string): Promise<Skill | null> {
  const { installed, upcoming } = await listSkills();
  return [...installed, ...upcoming].find((skill) => skill.id === id) ?? null;
}

export async function getSolutionPack(id: string): Promise<SolutionPack | null> {
  const { items } = await listSolutionPacks();
  return items.find((item) => item.id === id) ?? null;
}
