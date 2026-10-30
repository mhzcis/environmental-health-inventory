import { useState, useEffect } from 'react';
import { CheckCircle, X, AlertTriangle } from 'lucide-react';
import { notificationService } from '../services/notificationService';

interface NotificationItem {
  id: string;
  message: string;
  type: 'success' | 'error';
}

export default function SuccessNotification() {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  useEffect(() => {
    // Subscribe to success triggers
    const unsubscribe = notificationService.subscribe((message, type = 'success') => {
      const id = Math.random().toString(36).substring(2, 9);
      
      // Add notification
      setNotifications((prev) => [...prev, { id, message, type }]);

      // Trigger standard sweet subtle success audio feedback
      try {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        // Play high-quality modern notification beep
        const osc1 = audioCtx.createOscillator();
        const osc2 = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        if (type === 'error') {
          osc1.type = 'sawtooth';
          osc1.frequency.setValueAtTime(150, audioCtx.currentTime);
          osc1.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.2);
          osc2.type = 'square';
          osc2.frequency.setValueAtTime(100, audioCtx.currentTime);
          osc2.frequency.exponentialRampToValueAtTime(80, audioCtx.currentTime + 0.2);
        } else {
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
        osc1.frequency.exponentialRampToValueAtTime(1046.50, audioCtx.currentTime + 0.12); // C6

        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(659.25, audioCtx.currentTime); // E5
        osc2.frequency.exponentialRampToValueAtTime(1318.51, audioCtx.currentTime + 0.15); // E6

        }
        gainNode.gain.setValueAtTime(0.001, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.02, audioCtx.currentTime + 0.05);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);

        osc1.connect(gainNode);
        osc2.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        osc1.start();
        osc2.start();
        
        osc1.stop(audioCtx.currentTime + 0.3);
        osc2.stop(audioCtx.currentTime + 0.3);
      } catch (e) {
        // Audio fallback if user hasn't interacted or unsupported browser
      }

      // Auto dismiss after 4 seconds
      setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }, 4200);
    });

    return unsubscribe;
  }, []);

  const handleDismiss = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  return (
    <div
      id="global-notifications-root"
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        maxWidth: '420px',
        width: 'calc(100% - 48px)',
        pointerEvents: 'none',
        direction: 'rtl'
      }}
    >
      {notifications.map((notification) => (
        <div
          key={notification.id}
          style={{
            pointerEvents: 'auto',
            background: 'rgba(255, 255, 255, 0.95)',
            backdropFilter: 'blur(10px)',
            borderRight: `5px solid ${notification.type === 'error' ? '#ef4444' : '#16a34a'}`,
            boxShadow: `0 10px 25px -5px ${notification.type === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(22, 163, 74, 0.15)'}, 0 8px 10px -6px rgba(0, 0, 0, 0.05)`,
            borderRadius: '12px',
            padding: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            width: '100%',
            boxSizing: 'border-box',
            animation: 'fadeInSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
            <div style={{ color: notification.type === 'error' ? '#ef4444' : '#16a34a', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              {notification.type === 'error' ? <AlertTriangle size={22} strokeWidth={2.5} /> : <CheckCircle size={22} strokeWidth={2.5} />}
            </div>
            <span
              style={{
                fontFamily: '"Cairo", sans-serif',
                fontWeight: 600,
                fontSize: '0.925rem',
                color: '#1e293b',
                lineHeight: 1.5,
                textAlign: 'start'
              }}
            >
              {notification.message}
            </span>
          </div>
          
          <button
            onClick={() => handleDismiss(notification.id)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#475569';
              e.currentTarget.style.backgroundColor = '#f1f5f9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#94a3b8';
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
