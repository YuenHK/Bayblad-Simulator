import type { TopDesign } from "@steam-top/domain";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { ExplodedView } from "./ExplodedView";

export function PreviewFallback({ design }: Readonly<{ design: TopDesign }>) {
  return (
    <div className="preview-fallback">
      <p role="status">裝置未能啟用 3D，已顯示分解圖</p>
      <ExplodedView design={design} />
    </div>
  );
}

type PreviewErrorBoundaryProps = Readonly<{
  children: ReactNode;
  design: TopDesign;
  resetKey: unknown;
}>;

type PreviewErrorBoundaryState = Readonly<{ failed: boolean }>;

export class PreviewErrorBoundary extends Component<
  PreviewErrorBoundaryProps,
  PreviewErrorBoundaryState
> {
  state: PreviewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PreviewErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Preview failures are isolated so the rest of the designer remains usable.
  }

  componentDidUpdate(previous: PreviewErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    return this.state.failed
      ? <PreviewFallback design={this.props.design} />
      : this.props.children;
  }
}
