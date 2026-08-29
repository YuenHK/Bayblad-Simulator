import { useEffect, useRef, type ReactNode } from "react";
export function AdminModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null),
    restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restore.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const element = dialog.current;
    const focusable = () => [
      ...(element?.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!,
        last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      restore.current?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="panel confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-modal-title"
      >
        <h2 id="admin-modal-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}
