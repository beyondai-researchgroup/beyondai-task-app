import { Injectable, signal } from '@angular/core';

/** The fixed checkbox categories a researcher can restrict uploads to — must match the admin
 *  backend's FILE_TYPE_CATEGORIES allowlist (admin-dashboard-andrejkatin/server/generic-tasks/
 *  routes.mjs) exactly. */
export const FILE_TYPE_EXTENSIONS: Record<string, string[]> = {
  PDF: ['.pdf'],
  WORD: ['.doc', '.docx'],
  EXCEL: ['.xls', '.xlsx', '.csv'],
  POWERPOINT: ['.ppt', '.pptx'],
  ZIP: ['.zip', '.rar', '.7z'],
  IMAGE: ['.jpg', '.jpeg', '.png', '.gif'],
  TEXT: ['.txt', '.md'],
};

export interface TaskState {
  participantId: string;
  lang: 'sr' | 'en';
  taskTitle: string;
  taskInstructionsText: string | null;
  hasPdf: boolean;
  timerMinutes: number;
  allowedFileTypes: string[];
  allowMultipleFiles: boolean;
  /** The magic-link token itself — the submit endpoint is token-addressed, same as resolveLink. */
  token: string;
}

const STORAGE_KEY = 'taskapp-state';

/**
 * Minimal session state: the resolved task + locked language for this run, keyed off the magic
 * link token. Persisted to sessionStorage so a page refresh mid-task doesn't lose it — same
 * pattern as every sibling app's StateService (REI-40/Big Five).
 */
@Injectable({ providedIn: 'root' })
export class StateService {
  private readonly _state = signal<TaskState | null>(this.restore());
  readonly state = this._state.asReadonly();

  setState(state: TaskState): void {
    this._state.set(state);
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }

  clear(): void {
    this._state.set(null);
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  private restore(): TaskState | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as TaskState) : null;
    } catch {
      return null;
    }
  }
}
