import type { MetaAgentSummary } from '@shared/agents';
import { Select } from '@renderer/components/ui';

export function AgentPicker({
  agents,
  value,
  onChange,
}: {
  agents: MetaAgentSummary[];
  value: string | null;
  onChange: (agentId: string | null) => void;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs text-fg-2">
      Agent
      <Select
        aria-label="Task agent"
        data-testid="task-agent-picker"
        value={value ?? ''}
        options={[
          { value: '', label: 'No agent — configure provider below' },
          ...agents.map((agent) => ({
            value: agent.id,
            label: `${agent.name} · ${agent.revision.slice(0, 8)}${agent.available ? '' : ' (unavailable)'}`,
          })),
        ]}
        onChange={(event) => onChange(event.target.value || null)}
      />
      {value ? (
        <span className="text-2xs text-fg-3">
          The selected agent owns provider, model, mode, and effort settings.
        </span>
      ) : null}
    </label>
  );
}
