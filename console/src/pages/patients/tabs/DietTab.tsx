import { App, Card, Empty, Image, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { listMealLogs, MEAL_TYPE_LABELS, type MealLog } from '../../../mock/meal-logs.ts';
import { formatDateTime } from '../../../utils/format.ts';
import './diet.css';

const { Text, Paragraph } = Typography;

const MEAL_COLORS: Record<MealLog['mealType'], string> = {
  breakfast: 'orange',
  lunch: 'green',
  dinner: 'blue',
  snack: 'purple',
};

/** 患者 Agent 主页的「饮食记录」Tab：展示客户晒餐与 Agent 点评（#57）。 */
export function DietTab({ patientId }: { patientId: string }) {
  const { message } = App.useApp();
  const [logs, setLogs] = useState<MealLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listMealLogs(patientId)
      .then((items) => {
        if (!cancelled) setLogs(items);
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(error instanceof Error ? error.message : '饮食记录加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, message]);

  if (loading) {
    return (
      <div className="diet-loading">
        <Spin />
        <div className="diet-loading-text">正在加载饮食记录…</div>
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="还没有饮食记录。客户在群里晒餐后，Agent 会自动记录在这里。"
      />
    );
  }

  return (
    <div className="diet-list">
      {logs.map((log) => (
        <Card key={log.id} size="small" className="diet-card">
          <div className="diet-card-body">
            <Image
              src={log.photoUrl}
              alt={`${MEAL_TYPE_LABELS[log.mealType]}照片`}
              width={132}
              height={104}
              style={{ objectFit: 'cover', borderRadius: 8 }}
            />
            <div className="diet-card-main">
              <Space size={8} wrap>
                <Tag bordered={false} color={MEAL_COLORS[log.mealType]}>
                  {MEAL_TYPE_LABELS[log.mealType]}
                </Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {formatDateTime(log.createdAt)} · 识别置信度 {Math.round(log.confidence * 100)}%
                </Text>
              </Space>
              <div className="diet-foods">
                {log.foods.map((food) => (
                  <span className="diet-food" key={`${log.id}-${food.name}`}>
                    {food.name}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {food.portion}
                    </Text>
                  </span>
                ))}
              </div>
              {log.agentComment && (
                <Paragraph className="diet-agent-comment">
                  <Text strong>Agent 点评：</Text>
                  {log.agentComment}
                </Paragraph>
              )}
              {log.notes && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {log.notes}
                </Text>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
