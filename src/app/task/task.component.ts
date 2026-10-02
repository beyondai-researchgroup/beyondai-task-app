import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DatabaseService } from '../services/database.service';
import { FILE_TYPE_EXTENSIONS, StateService } from '../services/state.service';
import { TimerDisplayComponent } from '../shared/timer-display/timer-display.component';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The task itself: title + instructions text (+ optional PDF download) and a drag-and-drop
 * upload zone at the bottom, gated behind sessionGuard (state only exists after a real
 * /link/:token resolve). Files are queued client-side (nothing uploads until Submit) so the
 * participant can review/remove before sending, matching every other instrument app's one-shot
 * submit shape in this project. On timer expiry, whatever's currently queued (possibly nothing)
 * is auto-submitted with isTimedOut=true, bypassing the manual "at least one file" requirement —
 * never fabricating a submission the participant didn't actually make, just honestly recording
 * what they had ready when time ran out.
 */
@Component({
  selector: 'app-task',
  standalone: true,
  imports: [TranslateModule, TimerDisplayComponent],
  templateUrl: './task.component.html',
  styleUrl: './task.component.scss',
})
export class TaskComponent {
  private db = inject(DatabaseService);
  private stateService = inject(StateService);
  private router = inject(Router);
  private translate = inject(TranslateService);

  readonly state = this.stateService.state()!;

  readonly instructionsParagraphs = computed(() =>
    (this.state.taskInstructionsText ?? '').split(/\n+/).map((p) => p.trim()).filter(Boolean)
  );

  readonly allowedExtensions = computed(() => {
    const cats = this.state.allowedFileTypes;
    if (!cats.length) return null; // no restriction
    return cats.flatMap((c) => FILE_TYPE_EXTENSIONS[c] ?? []);
  });

  readonly allowedTypesHint = computed(() => {
    const exts = this.allowedExtensions();
    return exts ? exts.join(', ') : this.translate.instant('TASK.ANY_FILE_TYPE');
  });

  readonly queuedFiles = signal<File[]>([]);
  readonly dragOver = signal(false);
  readonly fileError = signal<string | null>(null);

  readonly submitting = signal(false);
  readonly submitError = signal<string | null>(null);
  private finished = false;
  private lastAttemptWasTimedOut = false;

  readonly canSubmit = computed(() => this.queuedFiles().length > 0 && !this.submitting());

  private extensionOf(filename: string): string {
    const i = filename.lastIndexOf('.');
    return i === -1 ? '' : filename.slice(i).toLowerCase();
  }

  private validateAndQueue(files: File[]): void {
    this.fileError.set(null);
    const allowed = this.allowedExtensions();
    const current = this.queuedFiles();
    const accepted: File[] = [];

    for (const file of files) {
      if (!this.state.allowMultipleFiles && current.length + accepted.length >= 1) {
        this.fileError.set(this.translate.instant('TASK.ERROR_SINGLE_FILE_ONLY'));
        break;
      }
      if (current.length + accepted.length >= MAX_FILES) {
        this.fileError.set(this.translate.instant('TASK.ERROR_TOO_MANY_FILES', { max: MAX_FILES }));
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        this.fileError.set(this.translate.instant('TASK.ERROR_FILE_TOO_LARGE', { name: file.name }));
        continue;
      }
      if (allowed && !allowed.includes(this.extensionOf(file.name))) {
        this.fileError.set(this.translate.instant('TASK.ERROR_FILE_TYPE', { name: file.name }));
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length) this.queuedFiles.update((list) => [...list, ...accepted]);
  }

  async downloadPdf(): Promise<void> {
    await this.db.downloadPdf(this.state.token, `${this.state.taskTitle}.pdf`);
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.validateAndQueue(Array.from(input.files));
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files?.length) this.validateAndQueue(Array.from(files));
  }

  removeFile(index: number): void {
    this.queuedFiles.update((list) => list.filter((_, i) => i !== index));
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    await this.doSubmit(false);
  }

  async onTimerExpired(): Promise<void> {
    if (this.finished || this.submitting()) return;
    await this.doSubmit(true);
  }

  /** Shown only after a failed submit — retries with whatever mode the failed attempt used
   *  (a timed-out auto-submit retries as timed-out too, never silently downgraded to a manual
   *  submit the participant never actually made). */
  async retry(): Promise<void> {
    await this.doSubmit(this.lastAttemptWasTimedOut);
  }

  private async doSubmit(isTimedOut: boolean): Promise<void> {
    if (this.finished) return;
    this.lastAttemptWasTimedOut = isTimedOut;
    this.submitting.set(true);
    this.submitError.set(null);
    const result = await this.db.submitTask(this.state.token, this.queuedFiles(), isTimedOut);
    this.submitting.set(false);
    if (result.ok) {
      this.finished = true;
      this.stateService.clear();
      this.router.navigate(['/done']);
    } else {
      this.submitError.set(result.error);
    }
  }
}
