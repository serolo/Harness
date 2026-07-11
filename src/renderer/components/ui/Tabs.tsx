// Segmented tab strip — ported from components/display/Tabs.jsx (center-pane switcher,
// dialog source tabs, etc).

export interface TabItem {
  id: string;
  label: string;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({
  tabs,
  value,
  onChange,
  className = '',
}: TabsProps): React.JSX.Element {
  return (
    <div role="tablist" className={`flex gap-1 ${className}`}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`rounded-2 px-2.5 py-1 text-sm font-medium transition-colors duration-fast ease-out ${
              active ? 'bg-bg-4 text-fg-1' : 'text-fg-2 hover:bg-bg-3'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
