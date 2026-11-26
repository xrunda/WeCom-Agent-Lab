/**
 * 素材地址集中管理（Vite 会按 base=/h5/ 拼出正确路径）。
 *
 * 这些图是从 docs/Images/UI 的设计稿里裁出来的**临时素材**：
 * 能让页面先成立，但不是最终授权摄影；正式素材替换时只改这里。
 */
const base = import.meta.env.BASE_URL;

export const ASSETS = {
  /** 今日餐食主图（H03 英雄卡） */
  mealHero: `${base}assets/meal-hero.jpg`,
  /** 餐食/文章方图（H08 封面、H05 缩略图、统计卡） */
  mealSquare: `${base}assets/meal-square.jpg`,
  /** 演示头像（H09） */
  avatar: `${base}assets/avatar.png`,
  /** 文章配图（演示实拍示意，来自 website/scripts/fixtures） */
  articleMillet: `${base}assets/article-millet.jpg`,
  articleFish: `${base}assets/article-fish.jpg`,
  articleNoodles: `${base}assets/article-noodles.jpg`,
} as const;
