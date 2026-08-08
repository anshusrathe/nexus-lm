<script lang="ts">
  import { Component, MarkdownRenderer, type App } from 'obsidian';
  import { onDestroy, onMount } from 'svelte';

  let { app, content = '', streaming = false, className = '' } = $props<{
    app: App;
    content: string;
    streaming?: boolean;
    className?: string;
  }>();

  let host: HTMLDivElement | undefined = $state();
  let renderer: Component | null = null;
  let generation = 0;

  onMount(() => {
    renderer = new Component();
    renderer.load();
  });

  onDestroy(() => renderer?.unload());

  $effect(() => {
    const next = content;
    const target = host;
    const component = renderer;
    if (!target || !component) return;

    const currentGeneration = ++generation;
    const delay = streaming ? 100 : 0;
    const timeout = window.setTimeout(() => {
      if (currentGeneration !== generation) return;
      target.empty();
      void MarkdownRenderer.render(app, next, target, '', component).then(() => {
        if (!target) return;
        const tables = target.querySelectorAll('table');
        tables.forEach(table => {
          if (!table.parentElement?.classList.contains('table-wrapper')) {
            const wrapper = document.createElement('div');
            wrapper.className = 'table-wrapper';
            table.parentNode?.insertBefore(wrapper, table);
            wrapper.appendChild(table);
          }
        });
      });
    }, delay);

    return () => window.clearTimeout(timeout);
  });
</script>

<div bind:this={host} class={className}></div>
