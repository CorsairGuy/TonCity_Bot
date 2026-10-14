import { Button } from '@primer/react';
import React from 'react';

interface BtnProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'danger' | 'default';
  size?: 'sm' | 'md';
  loading?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
  type?: 'button' | 'submit';
}

export function Btn({ children, onClick, variant = 'default', size = 'md', loading, disabled, style, type = 'button' }: BtnProps) {
  const primerVariant = variant === 'primary' ? 'primary' : variant === 'danger' ? 'danger' : 'default';
  return (
    <Button
      variant={primerVariant}
      size={size === 'sm' ? 'small' : 'medium'}
      onClick={onClick}
      loading={loading}
      disabled={disabled || loading}
      type={type}
      style={style}
    >
      {children}
    </Button>
  );
}