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
  BrainCircuit,
  Users,
  Wallet,
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
  { id: 'memory-query', label: 'Memory Query', icon: BrainCircuit, phase: 1 },
  { id: 'review-queue', label: 'Review Queue', icon: Inbox, phase: 1 },
  { id: 'memory-health', label: 'Memory Health', icon: HeartPulse, phase: 1 },
  { id: 'activity', label: 'Activity', icon: Activity, phase: 1 },
  // ADR-0010: a second repo root (the private Health-Management clone), not
  // memory. "Family Health" ≠ "Memory Health" (lint cadence) — keep both names.
  { id: 'family-health', label: 'Family Health', icon: Users, phase: 1 },
  // ADR-0011: a live external source (Firefly III), not a repo root. Read-only
  // and loopback-gated like Family Health; the detail stays in Firefly.
  { id: 'finance', label: 'Finance', icon: Wallet, phase: 1 },
  { id: 'operations', label: 'Operations', icon: TerminalSquare, phase: 2 },
  { id: 'audit-log', label: 'Audit Log', icon: ScrollText, phase: 3 },
  { id: 'settings', label: 'Settings', icon: Settings, phase: 1 },
];
