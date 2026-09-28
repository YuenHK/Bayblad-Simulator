import { useCallback } from "react";

/** Stable portal destination: hiding a canvas never changes its DOM parent. */
export function OutlineCanvasHost({ layerId, hidden, onHost }: Readonly<{
  layerId: string; hidden: boolean;
  onHost: (id: string, node: HTMLDivElement | null) => void;
}>) {
  const ref = useCallback((node: HTMLDivElement | null) => onHost(layerId, node), [layerId, onHost]);
  return <div className="outline-canvas-host" hidden={hidden} ref={ref} />;
}
