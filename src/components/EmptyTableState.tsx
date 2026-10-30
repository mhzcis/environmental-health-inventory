import React from 'react';
import { TableRow, TableCell, Box, Typography } from '@mui/material';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';

interface EmptyTableStateProps {
  colSpan: number;
  message?: string;
  minHeight?: string | number;
}

const EmptyTableState: React.FC<EmptyTableStateProps> = ({ colSpan, message = "لا توجد بيانات لعرضها", minHeight = 200 }) => {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} align="center" sx={{ borderBottom: 'none', py: 4 }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight,
            color: '#94a3b8',
            textAlign: 'center',
          }}
        >
          <InboxOutlinedIcon sx={{ fontSize: 48, mb: 1, opacity: 0.5 }} />
          <Typography variant="body1" sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 600 }}>
            {message}
          </Typography>
        </Box>
      </TableCell>
    </TableRow>
  );
};

export default EmptyTableState;
