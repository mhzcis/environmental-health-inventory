import React from 'react';
import { recordDiagnostic } from '../services/operationalDiagnostics';

/**
 * P12 G-2 — root React Error Boundary.
 * Catches render/lifecycle/constructor errors of its subtree only (React semantics); it does NOT
 * catch event-handler or asynchronous failures. The fallback is fixed Arabic text: no stack, no
 * Error.message. Recovery is user-initiated only (retry render / reload); nothing is cleared,
 * reset or reloaded automatically.
 */

interface Props {
  children: React.ReactNode;
  /** Injected for tests; defaults to window.location.reload. */
  onReload?: () => void;
}

interface State {
  failed: boolean;
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    try {
      recordDiagnostic({ source: 'error-boundary', phase: 'render', error, fallbackCategory: 'RENDER' });
    } catch {
      /* diagnostics failure must not break the fallback */
    }
  }

  private retry = (): void => {
    this.setState({ failed: false });
  };

  private reload = (): void => {
    try {
      if (this.props.onReload) this.props.onReload();
      else window.location.reload();
    } catch {
      /* ignore */
    }
  };

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" dir="rtl" style={{ fontFamily: '"Cairo", sans-serif', padding: 32, maxWidth: 560, margin: '64px auto', textAlign: 'center' }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>تعذر عرض التطبيق</h1>
        <p style={{ marginBottom: 20 }}>
          تعذر عرض الواجهة. لن يتم مسح أي بيانات محلية تلقائياً. يمكنك إعادة المحاولة أو إعادة تحميل الصفحة.
        </p>
        <button type="button" onClick={this.retry} style={{ marginInlineEnd: 12, padding: '8px 16px' }}>
          إعادة المحاولة
        </button>
        <button type="button" onClick={this.reload} style={{ padding: '8px 16px' }}>
          إعادة تحميل الصفحة
        </button>
      </div>
    );
  }
}

export default AppErrorBoundary;
