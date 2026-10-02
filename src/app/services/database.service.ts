import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';

const REQUEST_TIMEOUT_MS = 10_000;
// File uploads can legitimately take longer than a plain JSON round-trip — same 25MB-per-file /
// 20-file ceiling as the admin backend, generous enough for a slow connection.
const SUBMIT_TIMEOUT_MS = 120_000;

interface LinkResolveResponse {
  participantId: string;
  lang: 'sr' | 'en';
  taskTitle: string;
  taskInstructionsText: string | null;
  hasPdf: boolean;
  timerMinutes: number;
  allowedFileTypes: string[];
  allowMultipleFiles: boolean;
}

export type LinkResolveResult =
  | ({ ok: true; token: string } & LinkResolveResponse)
  | { ok: false; error: 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_COMPLETED' | 'NOT_ACTIVE' | 'SERVER_ERROR' };

export type SubmitTaskResult =
  | { ok: true }
  | { ok: false; error: string };

@Injectable({ providedIn: 'root' })
export class DatabaseService {
  private http = inject(HttpClient);

  async resolveLink(token: string): Promise<LinkResolveResult> {
    try {
      const res = await firstValueFrom(
        this.http.get<LinkResolveResponse>(`/api/link/${encodeURIComponent(token)}`).pipe(timeout(REQUEST_TIMEOUT_MS))
      );
      return { ok: true, token, ...res };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'NOT_FOUND' || code === 'EXPIRED' || code === 'ALREADY_COMPLETED' || code === 'NOT_ACTIVE') {
        return { ok: false, error: code };
      }
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  /** Fetches the assigned task's PDF as a blob — the token itself re-authorizes the request
   *  (no separate auth header exists in this app), same download mechanics as every other
   *  BYTEA-in-Postgres download in this project's admin backends. */
  async downloadPdf(token: string, filename: string): Promise<void> {
    const res = await fetch(`/api/task/pdf/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async submitTask(token: string, files: File[], isTimedOut: boolean): Promise<SubmitTaskResult> {
    const formData = new FormData();
    for (const file of files) formData.append('files', file, file.name);
    formData.append('isTimedOut', String(isTimedOut));
    try {
      await firstValueFrom(
        this.http.post<void>(`/api/link/${encodeURIComponent(token)}/submit`, formData).pipe(timeout(SUBMIT_TIMEOUT_MS))
      );
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SUBMIT_FAILED' };
    }
  }
}
