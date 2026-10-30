/**
 * Global success notification service.
 * Allows triggering success messages from anywhere in the app.
 */

type Listener = (message: string, type?: 'success' | 'error') => void;

class NotificationService {
  private listeners: Set<Listener> = new Set();

  /**
   * Subscribe to success notifications.
   * Returns an unsubscribe function.
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Post a success notification.
   */
  showSuccess(message: string): void {
    this.listeners.forEach((listener) => {
      try {
        listener(message, 'success');
      } catch (err) {

      }
    });
  }

  showError(message: string): void {
    this.listeners.forEach((listener) => {
      try {
        listener(message, 'error');
      } catch (err) {

      }
    });
  }
}

export const notificationService = new NotificationService();
