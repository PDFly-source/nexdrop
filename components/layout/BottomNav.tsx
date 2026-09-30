'use client';

import React from 'react';
import { Home, ArrowDownUp, MonitorSmartphone, Settings } from 'lucide-react';

export type WorkspaceTab = 'home' | 'transfers' | 'devices' | 'settings';

interface BottomNavProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  activeTransferCount?: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onTabChange,
  activeTransferCount = 0,
}) => {
  const tabs = [
    {
      id: 'home' as WorkspaceTab,
      label: 'Home',
      icon: Home,
    },
    {
      id: 'transfers' as WorkspaceTab,
      label: 'Transfers',
      icon: ArrowDownUp,
      badge: activeTransferCount > 0 ? activeTransferCount : undefined,
    },
    {
      id: 'devices' as WorkspaceTab,
      label: 'Devices',
      icon: MonitorSmartphone,
    },
    {
      id: 'settings' as WorkspaceTab,
      label: 'Settings',
      icon: Settings,
    },
  ];

  return (
    <nav aria-label="Primary" className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-white/[0.08] bg-nd-bg-0/95 backdrop-blur-lg">
      <div className="grid grid-cols-4 h-14">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex flex-col items-center justify-center gap-1 transition-colors ${
                isActive ? 'text-nd-teal' : 'text-nd-text-secondary hover:text-nd-text-primary'
              }`}
            >
              <div className="relative">
                <Icon className={`w-4 h-4 ${isActive ? 'stroke-[2.5]' : 'stroke-[1.8]'}`} />
                {tab.badge && (
                  <span className="absolute -top-1 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-nd-teal px-1 text-[9px] font-bold text-nd-bg-0">
                    {tab.badge}
                  </span>
                )}
              </div>
              <span className={`text-[10px] ${isActive ? 'font-semibold' : 'font-medium'}`}>
                {tab.label}
              </span>
              {isActive && (
                <span aria-hidden="true" className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] bg-nd-teal rounded-full" />
              )}
            </button>
          );
        })}
      </div>
      {/* Respect the home indicator on iOS standalone */}
      <div style={{ height: 'env(safe-area-inset-bottom)' }} />
    </nav>
  );
};
