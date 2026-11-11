import { QuestionCircleOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';

interface FieldHintProps {
  /** 悬浮或键盘聚焦时展示的说明 */
  text: string;
  /** 给读屏用的说明名称 */
  label?: string;
}

/**
 * 字段旁的问号说明：给新手解释「这个词是什么意思、该填谁」。
 * 用 Tooltip 而不是常驻文案，避免表单变长；键盘可聚焦。
 */
export function FieldHint({ text, label = '字段说明' }: FieldHintProps) {
  return (
    <Tooltip title={text}>
      <QuestionCircleOutlined
        aria-label={label}
        tabIndex={0}
        style={{
          color: 'rgba(0, 0, 0, 0.45)',
          cursor: 'help',
          fontSize: 12,
          marginLeft: 4,
        }}
      />
    </Tooltip>
  );
}
