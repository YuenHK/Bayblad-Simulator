export function WorkbenchTabs<T extends string>({ items, value, onChange, label, idPrefix, className = "" }: Readonly<{
  items: ReadonlyArray<Readonly<{ id: T; label: string; panelId: string }>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
  className?: string;
}>) {
  return <div role="tablist" aria-label={label} className={`workbench-tabs ${className}`}>
    {items.map((item, index) => <button key={item.id} id={`${idPrefix}-${item.id}`} type="button" role="tab"
      aria-selected={value === item.id} aria-controls={item.panelId} tabIndex={value === item.id ? 0 : -1}
      onClick={() => onChange(item.id)} onKeyDown={(event) => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % items.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else return;
        event.preventDefault();
        const target = items[next]!;
        onChange(target.id);
        document.getElementById(`${idPrefix}-${target.id}`)?.focus();
      }}>{item.label}</button>)}
  </div>;
}
