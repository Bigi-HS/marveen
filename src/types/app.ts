// Shared app-facing TypeScript types (Phase 0F, card 696cc1e1).
// Importable from backend route handlers and the Tauri frontend.

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface AgentStatus {
  id: string
  name: string
  status: 'idle' | 'working' | 'planning' | 'waiting' | 'error' | 'offline'
  lastSeen: number | null
}

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

export interface KanbanCard {
  id: string
  title: string
  status: 'planned' | 'in_progress' | 'waiting' | 'done' | 'icebox'
  priority: 'low' | 'normal' | 'high' | 'urgent'
  assignee: string | null
  project: string | null
  desc: string | null
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export interface JournalEntry {
  id: number
  content: string
  mood: string | null
  tags: string | null
  createdAt: number
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

// ---------------------------------------------------------------------------
// Workout
// ---------------------------------------------------------------------------

export interface WorkoutPlan {
  date: string
  exercises: WorkoutExercise[]
  notes: string | null
}

export interface WorkoutExercise {
  name: string
  sets: number | null
  reps: number | null
  weight: number | null
  unit: string | null
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface AppCalendarEvent {
  id: string
  summary: string
  start: string
  end: string
  location: string | null
  description: string | null
}
