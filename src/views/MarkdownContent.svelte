<script lang="ts">
  import { Component, MarkdownRenderer, TFile, type App } from 'obsidian';
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

  function setupInteractivity(container: HTMLElement): void {
    const internalLinks = container.querySelectorAll<HTMLAnchorElement>('a.internal-link');
    internalLinks.forEach((link) => {
      const href = link.getAttribute('data-href') || link.getAttribute('href');
      if (href) {
        link.addEventListener('click', async (e: MouseEvent) => {
          e.preventDefault();
          const file = app.metadataCache.getFirstLinkpathDest(href, '');
          if (file instanceof TFile) {
            await app.workspace.getLeaf().openFile(file);
          } else {
            const fileByPath = app.vault.getAbstractFileByPath(href);
            if (fileByPath instanceof TFile) {
              await app.workspace.getLeaf().openFile(fileByPath);
            } else {
              void app.workspace.openLinkText(href, '', false);
            }
          }
        });

        link.addEventListener('mouseover', (e: MouseEvent) => {
          const file = app.metadataCache.getFirstLinkpathDest(href, '');
          if (file instanceof TFile) {
            app.workspace.trigger('hover-link', {
              event: e,
              source: 'NEXUS_LM_AGENT',
              hoverParent: container,
              targetEl: link,
              linktext: href,
              sourcePath: file.path
            });
          }
        });
      }
    });

    container.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
      const href = link.getAttribute('href');
      if (href) {
        if (href.startsWith('obsidian://')) {
          link.addEventListener('click', (event: MouseEvent) => {
            event.preventDefault();
            window.open(href);
          });
        } else if (href.startsWith('http://') || href.startsWith('https://')) {
          link.addEventListener('click', (event: MouseEvent) => {
            event.preventDefault();
            window.open(href, '_blank');
          });
        } else if (!link.classList.contains('internal-link')) {
          link.addEventListener('click', async (event: MouseEvent) => {
            event.preventDefault();
            const decoded = decodeURIComponent(href);
            const file = app.metadataCache.getFirstLinkpathDest(decoded, '');
            if (file instanceof TFile) {
              await app.workspace.getLeaf().openFile(file);
            } else {
              const fileByPath = app.vault.getAbstractFileByPath(decoded);
              if (fileByPath instanceof TFile) {
                await app.workspace.getLeaf().openFile(fileByPath);
              } else {
                void app.workspace.openLinkText(decoded, '', false);
              }
            }
          });
          link.addEventListener('mouseover', (e: MouseEvent) => {
            const decoded = decodeURIComponent(href);
            const file = app.metadataCache.getFirstLinkpathDest(decoded, '');
            if (file instanceof TFile) {
              app.workspace.trigger('hover-link', {
                event: e,
                source: 'NEXUS_LM_AGENT',
                hoverParent: container,
                targetEl: link,
                linktext: decoded,
                sourcePath: file.path
              });
            }
          });
        }
      }
    });

    const allLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'));
    const footnoteRefs = allLinks.filter(link => {
      const href = link.getAttribute('href');
      const isInSup = link.closest('sup') !== null;
      const isFootnoteHref = href && (href.startsWith('#fn') || href.startsWith('#user-content-fn'));
      return isInSup || isFootnoteHref;
    });

    footnoteRefs.forEach((refLink) => {
      const href = refLink.getAttribute('href');
      if (!href || !href.startsWith('#')) return;

      refLink.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        const targetId = href.substring(1);
        let targetEl = container.querySelector(`#${CSS.escape(targetId)}`) as HTMLElement | null;
        if (!targetEl) {
          targetEl = container.querySelector(`li[id="${CSS.escape(targetId)}"]`) as HTMLElement | null;
        }
        if (!targetEl && targetId.includes('user-content')) {
          const simpleId = targetId.replace('user-content-', '');
          targetEl = container.querySelector(`#${CSS.escape(simpleId)}`) as HTMLElement | null;
        }
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });
  }

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
        setupInteractivity(target);
      });
    }, delay);

    return () => window.clearTimeout(timeout);
  });
</script>

<div bind:this={host} class={className}></div>
