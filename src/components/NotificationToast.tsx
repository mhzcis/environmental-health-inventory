import React from 'react';
import { Snackbar, Alert, AlertColor } from '@mui/material';

interface NotificationToastProps {
  open: boolean;
  message: string;
  severity: AlertColor;
  onClose: () => void;
  autoHideDuration?: number;
}

const NotificationToast: React.FC<NotificationToastProps> = ({
  open,
  message,
  severity,
  onClose,
  autoHideDuration = 4000
}) => {
  return (
    <Snackbar
      open={open}
      autoHideDuration={autoHideDuration}
      onClose={(_e, reason) => { if (reason === 'clickaway') return; onClose(); }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ zIndex: 9999 }}
    >
      <Alert
        onClose={onClose}
        severity={severity}
        variant="filled"
        sx={{
          width: '100%',
          direction: 'rtl',
          textAlign: 'start',
          borderRadius: '12px',
          fontFamily: '"Cairo", sans-serif',
          fontWeight: 'bold',
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
          alignItems: 'center',
          '& .MuiAlert-icon': {
            fontSize: '1.5rem',
            marginLeft: '0',
            marginRight: '12px'
          },
          '& .MuiAlert-message': {
            padding: '8px 0',
            width: '100%'
          },
          '& .MuiAlert-action': {
            paddingRight: '0',
            marginLeft: 'auto',
            paddingLeft: '16px'
          }
        }}
      >
        {message}
      </Alert>
    </Snackbar>
  );
};

export default NotificationToast;
