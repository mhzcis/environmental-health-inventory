import { createTheme, ThemeOptions } from '@mui/material/styles';
import rtlPlugin from 'stylis-plugin-rtl';
import { prefixer } from 'stylis';
import createCache from '@emotion/cache';

export const cacheRtl = createCache({
  key: 'muirtl',
  stylisPlugins: [prefixer, typeof rtlPlugin === 'function' ? rtlPlugin : (rtlPlugin as any).default || rtlPlugin],
});

export const getDesignTokens = (mode: 'light' | 'dark'): ThemeOptions => ({
  direction: 'rtl',
  palette: {
    mode,
    ...(mode === 'light'
      ? {
          primary: {
            main: '#007ab7', // Official UNRWA Light Blue
            light: '#3394c5',
            dark: '#00557f',
            contrastText: '#ffffff',
          },
          secondary: {
            main: '#0f172a', // Deep Slate / Navy
            light: '#334155',
            dark: '#020617',
            contrastText: '#ffffff',
          },
          warning: {
            main: '#f59e0b', // Amber
            light: '#fef3c7',
            dark: '#b45309',
          },
          error: {
            main: '#ef4444', // Red
            light: '#fee2e2',
            dark: '#b91c1c',
          },
          success: {
            main: '#10b981', // Emerald
            light: '#d1fae5',
            dark: '#047857',
          },
          info: {
            main: '#0ea5e9', // Sky Blue
            light: '#e0f2fe',
            dark: '#0369a1',
          },
          background: {
            default: '#f8fafc', // Modern Off-white/slate
            paper: '#ffffff',
          },
          text: {
            primary: '#0f172a',
            secondary: '#475569',
            disabled: '#94a3b8',
          },
          divider: '#e2e8f0',
        }
      : {
          // Dark mode palette changes
          primary: {
            main: '#38bdf8', 
            light: '#7dd3fc',
            dark: '#0284c7',
            contrastText: '#0f172a',
          },
          secondary: {
            main: '#94a3b8',
            light: '#cbd5e1',
            dark: '#475569',
            contrastText: '#0f172a',
          },
          warning: {
            main: '#fbbf24',
            light: '#fde68a',
            dark: '#d97706',
          },
          error: {
            main: '#f87171',
            light: '#fca5a5',
            dark: '#dc2626',
          },
          success: {
            main: '#34d399',
            light: '#6ee7b7',
            dark: '#059669',
          },
          info: {
            main: '#38bdf8',
            light: '#7dd3fc',
            dark: '#0284c7',
          },
          background: {
            default: '#0f172a', // Very dark slate
            paper: '#1e293b',   // slate-800
          },
          text: {
            primary: '#f8fafc',
            secondary: '#94a3b8',
            disabled: '#475569',
          },
          divider: '#334155',
        }),
  },
  typography: {
    fontFamily: '"Cairo", "Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h1: {
      fontFamily: '"Cairo", sans-serif',
      fontWeight: 800,
      fontSize: '2.5rem',
      lineHeight: 1.2,
      letterSpacing: '-0.02em',
    },
    h2: {
      fontFamily: '"Cairo", sans-serif',
      fontWeight: 800,
      fontSize: '2rem',
      lineHeight: 1.25,
      letterSpacing: '-0.01em',
    },
    h3: {
      fontFamily: '"Cairo", sans-serif',
      fontWeight: 700,
      fontSize: '1.5rem',
      lineHeight: 1.3,
    },
    h4: {
      fontFamily: '"Cairo", sans-serif',
      fontWeight: 700,
      fontSize: '1.25rem',
      lineHeight: 1.4,
    },
    h5: {
      fontFamily: '"Cairo", sans-serif',
      fontWeight: 600,
      fontSize: '1.125rem',
      lineHeight: 1.5,
    },
    h6: {
      fontFamily: '"Cairo", sans-serif',
      fontWeight: 600,
      fontSize: '1rem',
      lineHeight: 1.5,
    },
    body1: {
      fontFamily: '"Cairo", sans-serif',
      fontSize: '0.9375rem',
      lineHeight: 1.6,
      color: mode === 'light' ? '#334155' : '#cbd5e1',
    },
    body2: {
      fontFamily: '"Cairo", sans-serif',
      fontSize: '0.875rem',
      lineHeight: 1.6,
      color: mode === 'light' ? '#475569' : '#94a3b8',
    },
    button: {
      fontFamily: '"Cairo", sans-serif',
      fontWeight: 700,
      fontSize: '0.875rem',
      textTransform: 'none',
      letterSpacing: '0.01em',
    },
  },
  shape: {
    borderRadius: 12,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: '10px',
          padding: '10px 20px',
          boxShadow: 'none',
          transition: 'all 0.2s ease-in-out',
          '&:hover': {
            boxShadow: mode === 'light' ? '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)' : 'none',
            transform: 'translateY(-1px)',
          },
          '&:active': {
            transform: 'translateY(0)',
          },
        },

      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: '16px',
          border: mode === 'light' ? '1px solid #f1f5f9' : '1px solid #334155',
          boxShadow: mode === 'light' ? '0 4px 12px rgba(0, 0, 0, 0.03)' : '0 4px 12px rgba(0, 0, 0, 0.3)',
        },
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: {
          padding: '24px',
          '&:last-child': {
            paddingBottom: '24px',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          borderRadius: '16px',
          border: mode === 'light' ? '1px solid #f1f5f9' : '1px solid #334155',
          boxShadow: mode === 'light' ? '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)' : '0 4px 6px -1px rgba(0, 0, 0, 0.5)',
        },
        elevation1: {
          boxShadow: mode === 'light' ? '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)' : 'none',
        },
      },
    },
    MuiCheckbox: {
      styleOverrides: {
        root: {
          color: mode === 'light' ? '#94a3b8' : '#475569',
          '&.Mui-checked': {
            color: mode === 'light' ? '#007ab7' : '#38bdf8',
          },
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          fontFamily: '"Cairo", sans-serif',
          fontWeight: 600,
          color: mode === 'light' ? '#475569' : '#94a3b8',
          '&.Mui-focused': {
            color: mode === 'light' ? '#007ab7' : '#38bdf8',
          },
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
        size: 'small',
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: '10px',
          backgroundColor: mode === 'light' ? '#ffffff' : '#0f172a',
          transition: 'all 0.2s ease-in-out',
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: mode === 'light' ? '#cbd5e1' : '#334155',
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: mode === 'light' ? '#94a3b8' : '#475569',
          },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: mode === 'light' ? '#007ab7' : '#38bdf8',
            borderWidth: '2px',
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          fontFamily: '"Cairo", sans-serif',
          borderBottom: mode === 'light' ? '1px solid #e2e8f0' : '1px solid #334155',
          padding: '12px 16px', // Reduced padding for better space utilization
          whiteSpace: 'nowrap', // Crucial for responsive tables
          fontSize: '0.9rem',
          backgroundColor: 'inherit',
        },
        head: {
          fontWeight: 800,
          backgroundColor: mode === 'light' ? '#f8fafc' : '#0f172a',
          color: mode === 'light' ? '#334155' : '#cbd5e1',
          fontSize: '0.85rem',
          padding: '14px 16px',
        },
      },
    },
    MuiTableContainer: {
      styleOverrides: {
        root: {
          borderRadius: '16px',
          border: mode === 'light' ? '1px solid #e2e8f0' : '1px solid #334155',
          boxShadow: 'none',
          overflowX: 'auto',
        },
      },
    },
    MuiTablePagination: {
      styleOverrides: {
        root: {
          borderBottom: 'none',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: '8px',
          fontWeight: 600,
          fontFamily: '"Cairo", sans-serif',
          padding: '4px 8px',
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: '16px',
          boxShadow: mode === 'light' ? '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)' : '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          margin: '16px',
          width: 'calc(100% - 32px)',
          maxHeight: 'calc(100% - 32px)',
        },
      },
    },
    MuiBackdrop: {
      styleOverrides: {
        root: {
          backgroundColor: mode === 'light' ? 'rgba(15, 23, 42, 0.4)' : 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(2px)',
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          padding: '20px 24px',
          fontWeight: 700,
          fontSize: '1.25rem',
        },
      },
    },
    MuiDialogContent: {
      styleOverrides: {
        root: {
          padding: '20px 24px',
        },
      },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: {
          padding: '16px 24px',
          borderTop: mode === 'light' ? '1px solid #f1f5f9' : '1px solid #334155',
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: {
          borderColor: mode === 'light' ? '#e2e8f0' : '#334155',
        },
      },
    },
  },
});

export const theme = createTheme(getDesignTokens('light'));
