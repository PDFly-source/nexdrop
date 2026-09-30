'use client';

import React from 'react';
import { ArrowDownUp, Clipboard, History, Settings } from 'lucide-react';

export type WorkspaceTab = 'transfer' | 'clipboard' | 'history' | 'settings';

interface BottomNavProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  unreadClipboardCount?: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onTabChange,
  unreadClipboardCount = 0,
}) => {
  const tabs = [
    {
      id: 'transfer' as WorkspaceTab,
      label: 'Transfer',
      icon: ArrowDownUp,
    },
    {
      id: 'clipboard' as WorkspaceTab,
      label: 'Clipboard',
      icon: Clipboard,
      badge: unreadClipboardCount > 0 ? unreadClipboardCount : undefined,
    },
    {
      id: 'history' as WorkspaceTab,
      label: 'History',
      icon: History,
    },
    {
      id: 'settings' as WorkspaceTab,
      label: 'Settings',
      icon: Settings,
    },
  ];

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-white/[0.08] bg-[#070A0D]/95 backdrop-blur-lg pb-safe">
      <div className="grid grid-cols-4 h-14">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`relative flex flex-col items-center justify-center gap-1 transition-colors ${
                isActive ? 'text-[#00F5A0]' : 'text-[#9AA7AE] hover:text-[#F5F7F8]'
              }`}
            >
              <div className="relative">
                <Icon className={`w-4 h-4 ${isActive ? 'stroke-[2.5]' : 'stroke-[1.8]'}`} />
                {tab.badge && (
                  <span className="absolute -top-1 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#00F5A0] px-1 text-[9px] font-bold text-[#070A0D]">
                    {tab.badge}
                  </span>
                )}
              </div>
              <span className={`text-[10px] ${isActive ? 'font-semibold' : 'font-medium'}`}>
                {tab.label}
              </span>
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] bg-[#00F5A0] rounded-full" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
