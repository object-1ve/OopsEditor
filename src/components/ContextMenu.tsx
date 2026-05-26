import React, { useEffect, useRef, useState, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    if (menuRef.current) {
      // Use a small delay to ensure the DOM has rendered and we can get accurate measurements
      // especially with animations
      const updatePosition = () => {
        if (!menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        const { innerWidth, innerHeight } = window;

        let adjustedX = x;
        let adjustedY = y;

        // Check if menu width is actually measured
        const menuWidth = rect.width || 180; // fallback to min-w
        const menuHeight = rect.height || (items.length * 32 + 20); // rough fallback

        // 如果超出右侧边界，向左偏移
        if (x + menuWidth > innerWidth) {
          adjustedX = innerWidth - menuWidth - 10;
        }

        // 如果超出底部边界，向上偏移
        if (y + menuHeight > innerHeight) {
          adjustedY = innerHeight - menuHeight - 10;
        }

        // 确保不会超出左侧和顶部边界
        adjustedX = Math.max(10, adjustedX);
        adjustedY = Math.max(10, adjustedY);

        setPosition({ left: adjustedX, top: adjustedY });
        setIsVisible(true);
      };

      // Initial calculation
      updatePosition();
      
      // Second pass after a frame to catch any size changes from rendering/styles
      const frameId = requestAnimationFrame(updatePosition);
      return () => cancelAnimationFrame(frameId);
    }
  }, [x, y, items]);

  return createPortal(
    <div
      ref={menuRef}
      className={`fixed z-[1000] min-w-[180px] max-h-[calc(100vh-20px)] overflow-y-auto scrollbar-none border border-[#dccabc] bg-[#fffaf4] py-1 shadow-[0_8px_24px_rgba(123,75,57,0.18)] rounded-md animate-in fade-in zoom-in duration-100 origin-top-left ${isVisible ? "opacity-100" : "opacity-0"}`}
      style={{ left: position.left, top: position.top }}
    >
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {item.separator ? (
            <div className="mx-2 my-1 h-px bg-[#ead8cb]" />
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                item.onClick();
                onClose();
              }}
              className={`group flex w-full items-center gap-3 px-3 py-1.5 text-xs transition-colors ${
                item.danger
                  ? "text-error hover:bg-error/10 hover:text-error"
                  : "text-[#3b3027] hover:bg-[#f3e3d6] hover:text-[#b85a3e]"
              }`}
            >
              {item.icon && <span className="opacity-75 group-hover:opacity-100">{item.icon}</span>}
              <span className="flex-1 text-left">{item.label}</span>
            </button>
          )}
        </React.Fragment>
      ))}
    </div>,
    document.body
  );
}
