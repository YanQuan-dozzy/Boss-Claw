import React, { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    let adjustedX = x;
    let adjustedY = y;

    if (x + rect.width > window.innerWidth) {
      adjustedX = window.innerWidth - rect.width - 8;
    }
    if (y + rect.height > window.innerHeight) {
      adjustedY = window.innerHeight - rect.height - 8;
    }

    setPos({ x: adjustedX, y: adjustedY });
  }, [x, y]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="custom-context-menu"
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      role="menu"
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`context-menu-item${item.danger ? ' is-danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            if (!item.disabled && item.onClick) {
              item.onClick();
              onClose();
            }
          }}
          role="menuitem"
        >
          {item.icon && <span className="context-menu-item__icon">{item.icon}</span>}
          <span className="context-menu-item__label">{item.label}</span>
        </button>
      ))}
    </div>
  );
};
