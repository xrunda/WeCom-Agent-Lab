import { Tag, Tooltip } from 'antd';

/** B 档页面统一标签：提醒用户当前是预置示例数据，不是真实链路结果 */
export function SampleDataTag({ compact = false }: { compact?: boolean }) {
  return (
    <Tooltip title="当前页数据为预置示例，编辑不会影响真实服务链路">
      <Tag className="sample-data-tag">{compact ? '示例' : '示例数据'}</Tag>
    </Tooltip>
  );
}
