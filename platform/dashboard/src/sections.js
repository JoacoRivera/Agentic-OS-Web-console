import {
  LayoutDashboard,
  BookOpen,
  Workflow,
  Sparkles,
  Inbox,
  HeartPulse,
  Activity,
  TerminalSquare,
  ScrollText,
  Settings,
} from 'lucide-react';

/**
 * Sidebar sections (plan order). Platform Apps is deliberately absent —
 * deferred out of P1 (ADR-0004). `phase` > 1 renders as a placeholder.
 */
export const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, phase: 1 },
  { id: 'documentation', label: 'Documentation', icon: BookOpen, phase: 1 },
  { id: 'workflows', label: 'Workflows', icon: Workflow, phase: 1 },
  { id: 'skills', label: 'Skills', icon: Sparkles, phase: 1 },
  { id: 'review-queue', label: 'Review Queue', icon: Inbox, phase: 1 },
  { id: 'memory-health', label: 'Memory Health', icon: HeartPulse, phase: 1 },
  { id: 'activity', label: 'Activity', icon: Activity, phase: 1 },
  { id: 'operations', label: 'Operations', icon: TerminalSquare, phase: 2 },
  { id: 'audit-log', label: 'Audit Log', icon: ScrollText, phase: 3 },
  { id: 'settings', label: 'Settings', icon: Settings, phase: 1 },
];
