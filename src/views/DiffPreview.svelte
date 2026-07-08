<script lang="ts">
  import { setIcon } from 'obsidian';
  import { onMount } from 'svelte';

  interface DiffLine {
    type: 'added' | 'removed' | 'unchanged';
    lineNumber: number;
    content: string;
  }

  let { original = '', modified = '', path = '', showUnchanged = false } = $props<{
    original: string;
    modified: string;
    path: string;
    showUnchanged?: boolean;
  }>();

  let viewMode = $state<'unified' | 'side-by-side'>('unified');

  let diffLines = $derived((): DiffLine[] => {
    const origLines = original.split('\n');
    const modLines = modified.split('\n');
    const maxLen = Math.max(origLines.length, modLines.length);
    const result: DiffLine[] = [];

    for (let i = 0; i < maxLen; i++) {
      const orig = origLines[i] ?? '';
      const modLine = modLines[i] ?? '';
      if (orig === modLine) {
        result.push({ type: 'unchanged', lineNumber: i + 1, content: orig });
      } else if (orig === '' || orig === undefined) {
        result.push({ type: 'added', lineNumber: i + 1, content: modLine });
      } else if (modLine === '' || modLine === undefined) {
        result.push({ type: 'removed', lineNumber: i + 1, content: orig });
      } else {
        result.push({ type: 'removed', lineNumber: i + 1, content: orig });
        result.push({ type: 'added', lineNumber: i + 1, content: modLine });
      }
    }

    return result;
  });

  let visibleLines = $derived((): DiffLine[] => {
    if (showUnchanged) return diffLines;
    const significant = diffLines.filter((l) => l.type !== 'unchanged');
    if (significant.length === 0) return diffLines.slice(0, 5);
    return significant;
  });

  let changeCount = $derived((): { added: number; removed: number } => {
    let added = 0;
    let removed = 0;
    for (const line of diffLines) {
      if (line.type === 'added') added++;
      if (line.type === 'removed') removed++;
    }
    return { added, removed };
  });

  let containerEl: HTMLDivElement | undefined = $state();

  function applyIcons(el: HTMLDivElement | undefined): void {
    if (!el) return;
    el.querySelectorAll('[data-lucide-icon]').forEach((iconEl) => {
      setIcon(iconEl as HTMLElement, iconEl.getAttribute('data-lucide-icon') ?? '');
    });
  }

  onMount(() => applyIcons(containerEl));

  $effect(() => {
    visibleLines;
    if (containerEl) {
      window.setTimeout(() => applyIcons(containerEl), 0);
    }
  });
</script>

<div bind:this={containerEl} class="diff-preview-container">
  <div class="diff-preview-header">
    <div class="diff-preview-path">
      <span class="diff-preview-path-icon" data-lucide-icon="file-text"></span>
      <span class="diff-preview-path-text">{path}</span>
    </div>
    <div class="diff-preview-controls">
      <button
        class="diff-preview-mode-btn"
        class:diff-preview-mode-btn--active={viewMode === 'unified'}
        onclick={() => (viewMode = 'unified')}
      >Unified</button>
      <button
        class="diff-preview-mode-btn"
        class:diff-preview-mode-btn--active={viewMode === 'side-by-side'}
        onclick={() => (viewMode = 'side-by-side')}
      >Side-by-side</button>
    </div>
  </div>

  <div class="diff-preview-stats">
    <span class="diff-preview-stat diff-preview-stat--added">
      <span class="diff-preview-stat-icon" data-lucide-icon="plus"></span>
      {changeCount.added} added
    </span>
    <span class="diff-preview-stat diff-preview-stat--removed">
      <span class="diff-preview-stat-icon" data-lucide-icon="minus"></span>
      {changeCount.removed} removed
    </span>
  </div>

  <div class="diff-preview-content" class:diff-preview-content--side-by-side={viewMode === 'side-by-side'}>
    {#each visibleLines as line}
      <div class="diff-line diff-line--{line.type}">
        <span class="diff-line-number">{line.lineNumber}</span>
        <span class="diff-line-marker">
          {#if line.type === 'added'}+{:else if line.type === 'removed'}-{/if}
        </span>
        <span class="diff-line-content">{line.content}</span>
      </div>
    {/each}
  </div>

  {#if !showUnchanged && diffLines.length > visibleLines.length}
    <div class="diff-preview-truncated">
      Showing {visibleLines.length} of {diffLines.length} changed lines.
    </div>
  {/if}
</div>
