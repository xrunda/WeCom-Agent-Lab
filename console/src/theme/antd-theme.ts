import type { ThemeConfig } from 'antd';

import { FONT_FAMILY, consoleTokens as t } from './tokens.ts';

/**
 * 全局 Ant Design 主题。
 *
 * 原则：
 * - 品牌青是唯一强调色，语义色只用于状态；
 * - 13px 基准字号 + 34px 控件高度，向医疗后台的密排阅读靠拢；
 * - 阴影只留给浮层，页面内的层级靠细线与留白表达。
 */
export const consoleTheme: ThemeConfig = {
  token: {
    colorPrimary: t.brand,
    colorInfo: t.brand,
    colorSuccess: t.positive,
    colorWarning: t.warning,
    colorError: t.danger,
    colorText: t.ink,
    colorTextSecondary: t.muted,
    colorTextTertiary: t.muted2,
    colorTextQuaternary: '#84949a',
    colorBorder: t.line,
    colorBorderSecondary: t.line,
    colorBgLayout: t.canvas,
    colorBgContainer: t.surface,
    colorBgElevated: t.surface,
    colorFillAlter: t.surface2,
    colorFillSecondary: t.surface2,
    colorLink: t.brand,
    colorLinkHover: t.brandDeep,
    borderRadius: 8,
    borderRadiusLG: 10,
    borderRadiusSM: 6,
    fontFamily: FONT_FAMILY,
    fontSize: 13,
    controlHeight: 34,
    controlHeightSM: 28,
    controlHeightLG: 38,
    lineWidth: 1,
    boxShadowSecondary: '0 6px 20px rgba(16, 42, 50, 0.10)',
  },
  components: {
    Layout: {
      headerBg: t.surface,
      siderBg: t.surface,
      bodyBg: t.canvas,
      headerHeight: 56,
      headerPadding: '0 28px',
      triggerBg: t.surface,
      triggerColor: t.muted,
    },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemColor: t.ink2,
      itemHoverColor: t.ink,
      itemHoverBg: t.surface2,
      itemSelectedColor: t.brandDeep,
      itemSelectedBg: t.brandTint,
      itemHeight: 36,
      itemBorderRadius: 8,
      itemMarginInline: 0,
      itemMarginBlock: 1,
      itemPaddingInline: 10,
      iconSize: 16,
      collapsedIconSize: 16,
      iconMarginInlineEnd: 10,
      groupTitleColor: t.muted2,
      groupTitleFontSize: 11,
    },
    Table: {
      headerBg: t.surface2,
      headerColor: t.muted2,
      headerSplitColor: 'transparent',
      rowHoverBg: '#f7faf9',
      borderColor: t.line,
      cellPaddingBlock: 9,
      cellPaddingInline: 16,
      cellPaddingBlockMD: 9,
      cellPaddingInlineMD: 16,
      headerBorderRadius: 0,
      footerBg: t.surface,
    },
    Button: {
      paddingInline: 13,
      fontWeight: 400,
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Tag: {
      defaultBg: t.surface2,
      defaultColor: t.muted,
      borderRadiusSM: 4,
    },
    Segmented: {
      trackBg: '#eef2f1',
      trackPadding: 2,
      itemColor: t.muted,
      itemSelectedBg: t.surface,
      itemSelectedColor: t.ink,
    },
    Card: {
      headerFontSize: 14,
      headerHeight: 48,
      headerBg: 'transparent',
    },
    Select: {
      optionSelectedBg: t.brandTint,
      optionSelectedColor: t.brandDeep,
    },
    Input: {
      activeShadow: '0 0 0 3px rgba(15, 118, 110, 0.16)',
    },
    Form: {
      labelColor: t.ink2,
      labelFontSize: 12,
      verticalLabelPadding: '0 0 6px',
      itemMarginBottom: 18,
    },
  },
};
