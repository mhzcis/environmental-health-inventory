import React from 'react';
import { Box, Button, Typography, Paper } from '@mui/material';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import HomeIcon from '@mui/icons-material/Home';
import { Link as RouterLink } from 'react-router-dom';

/**
 * Arabic RTL not-found page for unknown hash routes.
 * Unknown paths previously rendered a blank main area inside AppLayout.
 */
const NotFound: React.FC = () => {
  return (
    <Box
      dir="rtl"
      data-testid="not-found-page"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: { xs: '50vh', sm: '60vh' },
        p: { xs: 2, sm: 3 },
      }}
    >
      <Paper
        elevation={0}
        sx={{
          maxWidth: 520,
          width: '100%',
          textAlign: 'center',
          p: { xs: 3, sm: 4 },
          borderRadius: '16px',
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <SearchOffIcon
          sx={{ fontSize: 64, color: '#94a3b8', mb: 1.5, opacity: 0.7 }}
          aria-hidden
        />
        <Typography
          variant="h5"
          component="h1"
          sx={{
            fontFamily: '"Cairo", sans-serif',
            fontWeight: 700,
            color: 'text.primary',
            mb: 1,
          }}
        >
          الصفحة غير موجودة
        </Typography>
        <Typography
          variant="body1"
          sx={{
            fontFamily: '"Cairo", sans-serif',
            color: '#64748b',
            mb: 3,
            lineHeight: 1.8,
          }}
        >
          المسار الذي طلبته غير معروف في النظام. يمكنك العودة إلى الصفحة الرئيسية
          للمتابعة.
        </Typography>
        <Button
          component={RouterLink}
          to="/"
          variant="contained"
          startIcon={<HomeIcon />}
          sx={{
            fontFamily: '"Cairo", sans-serif',
            fontWeight: 700,
            borderRadius: '10px',
            px: 3,
            py: 1.1,
            bgcolor: '#007ab7',
            '&:hover': { bgcolor: '#00557f' },
          }}
        >
          العودة إلى الصفحة الرئيسية
        </Button>
      </Paper>
    </Box>
  );
};

export default NotFound;
