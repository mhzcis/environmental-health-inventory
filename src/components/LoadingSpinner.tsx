import React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';

interface LoadingSpinnerProps {
  message?: string;
  minHeight?: string | number;
}

const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ message = "جاري التحميل...", minHeight = 200 }) => {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight,
        p: 3,
        color: '#64748b',
        textAlign: 'center',
      }}
    >
      <CircularProgress size={40} thickness={4} sx={{ mb: 2, color: '#007ab7' }} />
      <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 600, animation: 'pulse 1.5s infinite ease-in-out' }}>
        {message}
      </Typography>
    </Box>
  );
};

export default LoadingSpinner;
