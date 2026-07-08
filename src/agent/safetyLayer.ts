import { normalizePath, Notice, Modal, TFile, type App } from 'obsidian';
import { mount, unmount } from 'svelte';
import type { ApprovalMode, ToolCall, AgentStep } from './types';
import DiffPreview from '../views/DiffPreview.svelte';
import { replaceContent, applyMultiEdit, type MultiEditOp } from './editEngine';
import { isWriteCliCommand } from './cliExecutor';

interface AuditEntry {
  timestamp: number;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  contentPreview: string;
}

export class SafetyLayer {
  private app: App;
  private denyList: string[];
  private approvalMode: ApprovalMode;
  private auditLog: AuditEntry[] = [];
  private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();

  constructor(app: App, denyList: string[], approvalMode: ApprovalMode) {
    this.app = app;
    this.denyList = denyList;
    this.approvalMode = approvalMode;
  }

  updateConfig(denyList: string[], approvalMode: ApprovalMode): void {
    this.denyList = denyList;
    this.approvalMode = approvalMode;
  }

  isPathAllowed(path: string): boolean {
    const normalized = normalizePath(path);
    for (const denied of this.denyList) {
      if (normalized.startsWith(denied) || normalized.includes('/' + denied + '/')) {
        return false;
      }
    }
    return true;
  }

  isPathTraversalSafe(path: string): boolean {
    const normalized = normalizePath(path);
    if (normalized.includes('..')) {
      return false;
    }
    return true;
  }

  needsApproval(toolCall: ToolCall): boolean {
    if (this.approvalMode === 'never') return false;
    if (this.approvalMode === 'all') return true;
    if (this.approvalMode === 'writes-only') {
      const writeTools = ['create_note', 'edit_note', 'multi_edit', 'edit_file', 'write_file', 'delete_file', 'move_file'];
      if (writeTools.includes(toolCall.name)) return true;
      // For the generic cli tool, check the command string dynamically
      if (toolCall.name === 'cli') {
        const cmd = String(toolCall.arguments.command ?? '');
        return isWriteCliCommand(cmd);
      }
      return false;
    }
    return false;
  }

  private async computeDiffContent(toolCall: ToolCall): Promise<{ original: string; modified: string } | null> {
    const filePath = String(toolCall.arguments.path ?? '');
    if (!filePath) return null;

    const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(file instanceof TFile)) return null;

    let originalContent: string;
    try {
      originalContent = await this.app.vault.read(file);
    } catch {
      return null;
    }

    if (toolCall.name === 'edit_note') {
      const newString = String(toolCall.arguments.newString ?? '');
      const oldString = String(toolCall.arguments.oldString ?? '');
      const insertAt = String(toolCall.arguments.insertAt ?? '');

      if (insertAt === 'start') {
        const sep = originalContent.startsWith('\n') ? '' : '\n';
        return { original: originalContent, modified: newString + sep + originalContent };
      }
      if (insertAt === 'end') {
        const sep = originalContent.endsWith('\n') ? '' : '\n';
        return { original: originalContent, modified: originalContent + sep + newString };
      }

      const result = replaceContent(originalContent, oldString, newString);
      if (result.matched) {
        return { original: originalContent, modified: result.result };
      }
      return null;
    }

    if (toolCall.name === 'multi_edit') {
      try {
        const parsed = JSON.parse(String(toolCall.arguments.edits ?? '[]'));
        const edits: MultiEditOp[] = Array.isArray(parsed) ? parsed : [parsed];
        const result = applyMultiEdit(originalContent, edits);
        if (result.success && result.result !== undefined) {
          return { original: originalContent, modified: result.result };
        }
      } catch {
        return null;
      }
      return null;
    }

    return null;
  }

  requestApproval(toolCall: ToolCall): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const toolName = toolCall.name;
      const argsSummary = JSON.stringify(toolCall.arguments).substring(0, 200);

      const notice = new Notice(`Agent wants to use ${toolName}`, 0);

      const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      this.pendingApprovals.set(approvalId, resolve);

      window.setTimeout(async () => {
        const modal = new Modal(this.app);
        const { contentEl } = modal;
        contentEl.empty();
        contentEl.addClass('agent-approval-modal');
        contentEl.createEl('h3', { text: 'Agent Approval Required' });
        contentEl.createEl('p', { text: `Tool: ${toolName}` });
        contentEl.createEl('pre', { text: argsSummary });

        const editTools = ['edit_note', 'multi_edit', 'write_file', 'create_note', 'edit_file'];
        let diffComponent: ReturnType<typeof mount> | null = null;
        if (editTools.includes(toolName)) {
          let diffData: { original: string; modified: string } | null = null;

          if (toolCall.arguments?.content) {
            const filePath = String(toolCall.arguments.path ?? '');
            let originalContent = '';
            if (filePath) {
              const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
              if (file instanceof TFile) {
                try { originalContent = await this.app.vault.read(file); } catch { originalContent = ''; }
              }
            }
            diffData = { original: originalContent, modified: String(toolCall.arguments.content) };
          } else {
            diffData = await this.computeDiffContent(toolCall);
          }

          if (diffData) {
            const diffContainer = contentEl.createDiv({ cls: 'agent-approval-diff' });
            diffComponent = mount(DiffPreview, {
              target: diffContainer,
              props: {
                original: diffData.original,
                modified: diffData.modified,
                path: String(toolCall.arguments.path ?? '') || 'new file',
              },
            });
          }
        }

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        const allowBtn = buttonContainer.createEl('button', { text: 'Allow', cls: 'mod-cta' });
        const denyBtn = buttonContainer.createEl('button', { text: 'Deny' });

        allowBtn.addEventListener('click', () => {
          notice.hide();
          this.pendingApprovals.delete(approvalId);
          if (diffComponent) unmount(diffComponent);
          resolve(true);
          modal.close();
        });

        denyBtn.addEventListener('click', () => {
          notice.hide();
          this.pendingApprovals.delete(approvalId);
          if (diffComponent) unmount(diffComponent);
          resolve(false);
          modal.close();
        });
        modal.open();
      }, 100);
    });
  }

  logAudit(entry: AuditEntry): void {
    this.auditLog.push(entry);
    if (this.auditLog.length > 1000) {
      this.auditLog.shift();
    }
  }

  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  clearAuditLog(): void {
    this.auditLog = [];
  }
}
