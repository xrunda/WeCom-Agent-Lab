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
      {logs.map((log) => {
        // 一条记录可能有多张原图（如一份主食 + 一瓶饮料），全部展示，不能只留首张
        const photos = log.photoUrls?.length
          ? log.photoUrls
          : log.photoUrl
            ? [log.photoUrl]
            : [];
        const multi = photos.length > 1;
        return (
          <Card key={log.id} size="small" className="diet-card">
            <div className="diet-card-body">
              {photos.length > 0 ? (
                <Image.PreviewGroup>
                  <div className={multi ? 'diet-photos diet-photos-multi' : 'diet-photos'}>
                    {photos.map((src, index) => (
                      <Image
                        key={`${log.id}-photo-${index}`}
                        src={src}
                        alt={`${MEAL_TYPE_LABELS[log.mealType]}照片 ${index + 1}`}
                        width={multi ? 64 : 132}
                        height={multi ? 64 : 104}
                        style={{ objectFit: 'cover', borderRadius: 8 }}
                        fallback="data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='132' height='104'%3E%3Crect width='100%25' height='100%25' fill='%23f2f2f2'/%3E%3Ctext x='50%25' y='50%25' font-size='12' fill='%23999' text-anchor='middle' dominant-baseline='middle'%3E照片无法加载%3C/text%3E%3C/svg%3E"
                      />
                    ))}
                  </div>
                </Image.PreviewGroup>
              ) : null}
              <div className="diet-card-main">
                <Space size={8} wrap>
                  <Tag bordered={false} color={MEAL_COLORS[log.mealType]}>
                    {MEAL_TYPE_LABELS[log.mealType]}
                  </Tag>
                  {/* 来源要能一眼分开：群里晒的餐和患者自己在 H5 记的餐是两回事 */}
                  <Tag bordered={false} color={log.source === 'h5' ? 'geekblue' : 'default'}>
                    {log.source === 'h5' ? '患者端 H5' : '服务群'}
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
        );
      })}
    </div>
  );
}
