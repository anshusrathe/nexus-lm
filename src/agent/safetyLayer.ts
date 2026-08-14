import { normalizePath, type App } from 'obsidian';
import type { AgentEventCallback, ApprovalMode, ToolCall } from './types';
import { isWriteCliCommand } from './cliExecutor';

interface AuditEntry {
  timestamp: number;
  toolName: string;
  args: Record<string, unknown>;
  success: boolean;
  contentPreview: string;
}

export function isPathDenied(path: string, denyList: string[]): boolean {
  const normalized = normalizePath(path).replace(/^\/+|\/+$/g, '');
  if (!normalized) return false;
  const pathParts = normalized.split('/');
  for (const deniedRaw of denyList) {
    const denied = normalizePath(deniedRaw).replace(/^\/+|\/+$/g, '');
    if (!denied) continue;
    const deniedParts = denied.split('/');
    if (deniedParts.length > pathParts.length) continue;
    let match = true;
    for (let i = 0; i < deniedParts.length; i++) {
      if (pathParts[i] !== deniedParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export class SafetyLayer {
  private app: App;
  private denyList: string[];
  private approvalMode: ApprovalMode;
  private auditLog: AuditEntry[] = [];
  private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
  private onEvent: AgentEventCallback = () => {};
  private lastApprovalId: string | null = null;

  constructor(app: App, denyList: string[], approvalMode: ApprovalMode) {
    this.app = app;
    this.denyList = denyList;
    this.approvalMode = approvalMode;
  }

  setOnEvent(onEvent: AgentEventCallback): void {
    this.onEvent = onEvent;
  }

  updateConfig(denyList: string[], approvalMode: ApprovalMode): void {
    this.denyList = denyList;
    this.approvalMode = approvalMode;
  }

  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  isPathAllowed(path: string): boolean {
    return !isPathDenied(path, this.denyList);
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
      const readTools = ['read_file', 'search_vault', 'get_outline', 'grep_vault', 'list_files', 'list_recent_files', 'get_backlinks', 'get_tags', 'web_search', 'webfetch', 'fetch_pdf', 'search_attached_indexes', 'saved_feeds', 'search_feeds'];
      if (readTools.includes(toolCall.name)) return false;
      const writeTools = ['create_note', 'edit_note', 'multi_edit', 'delete_file', 'move_file'];
      if (writeTools.includes(toolCall.name)) return true;
      if (toolCall.name === 'cli') {
        const cmd = String(toolCall.arguments.command ?? '');
        return isWriteCliCommand(cmd);
      }
      return false;
    }
    return false;
  }

  requestApproval(toolCall: ToolCall, thought: string, originalContent: string, isCreate: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      this.pendingApprovals.set(approvalId, resolve);
      this.lastApprovalId = approvalId;

      this.onEvent({
        type: 'pending_approval',
        data: {
          approvalId,
          toolName: toolCall.name,
          toolArgs: toolCall.arguments,
          thought,
          originalContent,
          isCreate,
        },
        timestamp: Date.now(),
      });
    });
  }

  getLastApprovalId(): string | null {
    return this.lastApprovalId;
  }

  resolveApproval(approvalId: string, approved: boolean): void {
    const resolver = this.pendingApprovals.get(approvalId);
    if (resolver) {
      this.pendingApprovals.delete(approvalId);
      resolver(approved);
    }
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
