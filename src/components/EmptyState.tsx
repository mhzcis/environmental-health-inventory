import React from 'react';
import { Box, Typography } from '@mui/material';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';

interface EmptyStateProps {
  message?: string;
  minHeight?: string | number;
}

const EmptyState: React.FC<EmptyStateProps> = ({ message = "لا توجد بيانات لعرضها", minHeight = 200 }) => {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight,
        p: 3,
        color: '#94a3b8',
        textAlign: 'center',
      }}
    >
      <InboxOutlinedIcon sx={{ fontSize: 48, mb: 1, opacity: 0.5 }} />
      <Typography variant="body1" sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 600 }}>
        {message}
      </Typography>
    </Box>
  );
};

export default EmptyState;
