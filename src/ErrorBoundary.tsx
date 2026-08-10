import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught app error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6 text-center font-sans">
          <div className="max-w-md bg-slate-900 border border-white/10 rounded-3xl p-8 shadow-2xl">
            <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-rose-500/20 text-rose-400 border border-rose-500/30">
              ⚠️
            </div>
            <h1 className="text-2xl font-black">Có lỗi xảy ra khi tải game</h1>
            <p className="mt-2 text-sm text-slate-400">
              {this.state.error?.message || "Đã xảy ra sự cố không xác định."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-6 w-full rounded-2xl bg-cyan-400 py-3 font-bold text-slate-950 hover:bg-cyan-300 transition-colors cursor-pointer"
            >
              Tải lại trang
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
