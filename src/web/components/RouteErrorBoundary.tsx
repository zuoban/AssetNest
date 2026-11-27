import { Component, type ErrorInfo, type ReactNode } from "react";

interface RouteErrorBoundaryProps {
  resetKey?: string;
  variant?: "inline" | "dialog";
  onError?: (error: Error) => void;
  onDismiss?: () => void;
  children: ReactNode;
}

interface RouteErrorBoundaryState {
  error: Error | null;
}

export function isChunkLoadError(error: Error): boolean {
  return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
    error.message
  );
}

export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[RouteErrorBoundary]", error, info.componentStack);
    this.props.onError?.(error);
  }

  componentDidUpdate(prevProps: RouteErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const chunkError = isChunkLoadError(this.state.error);
      const card = (
        <div className="mx-auto max-w-md rounded-xl border border-rose-200 bg-white p-6 text-center shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900">
            {chunkError ? "页面资源加载失败" : "页面渲染异常"}
          </h2>
          <p className="mt-2 text-xs text-rose-600">
            {chunkError
              ? "可能是应用版本已更新或网络短暂波动，请刷新页面后重试。"
              : this.state.error.message || "发生未知错误"}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            {this.props.onDismiss && (
              <button
                type="button"
                onClick={this.props.onDismiss}
                className="rounded-lg border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                关闭
              </button>
            )}
            {!chunkError && (
              <button
                type="button"
                onClick={this.handleRetry}
                className="rounded-lg border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                重试渲染
              </button>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              刷新页面
            </button>
          </div>
        </div>
      );

      if (this.props.variant === "dialog") {
        return (
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[1px]"
            onClick={this.props.onDismiss}
          >
            <div onClick={(event) => event.stopPropagation()}>{card}</div>
          </div>
        );
      }

      return <div className="py-8">{card}</div>;
    }

    return this.props.children;
  }
}
