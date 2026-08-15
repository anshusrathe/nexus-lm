<script lang="ts">
  import type { TraceStep, PendingAction } from './agentTraceTypes';
  import FileEditCard from './FileEditCard.svelte';
  import TraceIcon from './TraceIcon.svelte';

  let { step = null, pending = false, onApprove, onRevert } = $props<{
    step?: TraceStep | null;
    pending?: boolean;
    onApprove?: (approvalId: string) => void;
    onRevert?: (approvalId: string) => void;
  }>();
  let open = $state(false);

  let toolName = $derived(pending ? (step as unknown as PendingAction)?.toolName ?? '' : step?.toolName ?? '');
  let toolArgs = $derived(pending ? (step as unknown as PendingAction)?.toolArgs ?? null : step?.toolArgs ?? null);
  let isSemanticSearch = $derived(toolName === 'search_attached_indexes' && !pending && step?.semanticSearch !== null);

  let isFileOp = $derived(toolName === 'create_note' || toolName === 'edit_note' || toolName === 'multi_edit');
  let filePath = $derived(toolArgs?.path ? String(toolArgs.path) : '');
  let fileName = $derived(filePath ? filePath.split('/').pop() ?? filePath : '');
  let fileOpLabel = $derived(
    toolName === 'create_note' ? `Create ${fileName}`
      : toolName === 'edit_note' ? `Edit ${fileName}`
      : toolName === 'multi_edit' ? `Edit ${fileName}`
      : null
  );

  let approvalState = $derived(step?.approvalState ?? null);
  let approvalId = $derived(step?.approvalId ?? null);
  let isPendingApproval = $derived(approvalState === 'pending');
  let isReverted = $derived(approvalState === 'reverted');

  function formatArgs(args: Record<string, unknown> | null): string {
    if (!args) return '';
    const display = { ...args };
    if (isFileOp && display.path) delete display.path;
    if (isFileOp && 'content' in display) delete display.content;
    if (isFileOp && 'old_string' in display) delete display.old_string;
    if (isFileOp && 'new_string' in display) delete display.new_string;
    const text = Object.entries(display).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
    return text.length > 90 ? `${text.slice(0, 87)}...` : text;
  }

  let extraArgs = $derived(formatArgs(toolArgs));

  function handleApprove(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    if (approvalId) onApprove?.(approvalId);
  }

  function handleRevert(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    if (approvalId) onRevert?.(approvalId);
  }

  function handleButtonKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (isPendingApproval && approvalId) {
        onApprove?.(approvalId);
      } else if ((approvalState === 'approved' || isReverted) && approvalId) {
        onRevert?.(approvalId);
      }
    }
  }
</script>

<div class="agent-action-inline" class:agent-action-inline--pending={pending} class:agent-action-inline--approval={isPendingApproval} class:agent-action-inline--failed={!pending && step?.status === 'failed'}>
  <div class="agent-action-box-row">
    <button type="button" class="agent-action-box" aria-expanded={open} disabled={pending || isPendingApproval} onclick={() => { if (!pending && !isPendingApproval) open = !open; }}>
      {#if pending || isPendingApproval}
        <span class="agent-action-box-icon agent-action-spin"><TraceIcon name="loader-circle" /></span>
      {:else}
        <span class="agent-action-box-icon"><TraceIcon name={open ? 'chevron-down' : 'chevron-right'} /></span>
      {/if}
      {#if fileOpLabel}
        <span class="agent-action-box-label">
          {#if isPendingApproval}
            Waiting approval
          {:else if pending}
            {toolName === 'create_note' ? 'Creating' : 'Editing'}
          {:else}
            {toolName === 'create_note' ? 'Created' : 'Edited'}
          {/if}
        </span>
        <span class="agent-action-box-name">{fileName}</span>
        {#if extraArgs}<span class="agent-action-box-args">({extraArgs})</span>{/if}
      {:else}
        <span class="agent-action-box-name">{isSemanticSearch ? 'Semantic index search' : toolName}{toolArgs ? `(${formatArgs(toolArgs)})` : ''}</span>
      {/if}
    </button>
    {#if (isPendingApproval || approvalState === 'approved' || isReverted) && approvalId}
      <span
        role="button"
        tabindex="0"
        class="agent-approval-btn"
        class:agent-approval-btn--pending={isPendingApproval}
        class:agent-approval-btn--approved={approvalState === 'approved'}
        class:agent-approval-btn--reverted={isReverted}
        onclick={isPendingApproval ? handleApprove : handleRevert}
        onkeydown={handleButtonKeydown}
        title={isPendingApproval ? 'Approve file operation' : 'Revert file operation'}
      >
        {#if isPendingApproval}
          <TraceIcon name="check" />
        {:else if isReverted}
          <TraceIcon name="check" />
        {:else}
          <TraceIcon name="undo-2" />
        {/if}
      </span>
    {/if}
  </div>
  {#if !pending && !isPendingApproval && open && (step?.toolArgs || step?.toolProgress)}
    <div class="agent-action-box-detail">
      {#if step?.toolArgs}<pre>{JSON.stringify(step.toolArgs, null, 2)}</pre>{/if}
      {#if step?.toolProgress}<pre class="agent-tool-progress">{step.toolProgress}</pre>{/if}
    </div>
  {/if}
  {#if !pending && step?.semanticSearch}
    <div class="agent-semantic-search-summary">
      <span>{step.semanticSearch.resultCount} passage{step.semanticSearch.resultCount === 1 ? '' : 's'} retrieved</span>
      <span>Query: {step.semanticSearch.query}</span>
    </div>
  {/if}
  {#if !pending && step?.fileEditData}
    <FileEditCard
      edit={step.fileEditData}
      approvalState={approvalState}
      approvalId={approvalId}
      {onApprove}
      {onRevert}
    />
  {/if}
  {#if !pending && step?.status === 'failed' && step?.error}
    <div class="agent-action-inline-error">
      <span class="agent-action-inline-error-icon">&#10006;</span>
      <span class="agent-action-inline-error-text">{step.error}</span>
    </div>
  {/if}
</div>
