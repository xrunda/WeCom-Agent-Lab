import { useTerm } from '../../../auth/AuthContext.tsx';
import { PagePlaceholder } from '../../../components/PagePlaceholder.tsx';

export default function AgentSettingsPage() {
  const term = useTerm();

  return (
    <PagePlaceholder
      title="Agent 设定"
      description={`Agent 名字、${term}称谓、语气说明与头像。`}
      tier="A"
      owner="WP-L（#51）"
    />
  );
}
