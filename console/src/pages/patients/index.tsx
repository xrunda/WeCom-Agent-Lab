import { useTerm } from '../../auth/AuthContext.tsx';
import { PagePlaceholder } from '../../components/PagePlaceholder.tsx';

export default function PatientsPage() {
  const term = useTerm();

  return (
    <PagePlaceholder
      title={`${term} Agent`}
      description={`管理${term}档案、记忆、主动计划、办事记录与对话时间线。`}
      tier="A"
      owner="WP-K（#45）"
    />
  );
}
