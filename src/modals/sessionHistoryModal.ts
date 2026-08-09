import { App, setIcon } from 'obsidian';
import type { AIChatSessionManager } from '../managers/aiChatSessionManager';
import { createDetached } from '../utils/domUtils';

export interface SessionHistoryModalOptions {
  app: App;
  aiChatSessionManager: AIChatSessionManager;
  activeViewType: 'chat' | 'agent';
  onLoadChatSession: (id: string) => Promise<void>;
  onLoadAgentSession: (id: string) => Promise<void>;
}

export function openSessionHistoryModal(options: SessionHistoryModalOptions): HTMLElement {
  const existing = document.querySelector('.ai-chat-session-history-modal');
  if (existing) {
    existing.remove();
  }

  const activeDoc = options.app.workspace.containerEl?.ownerDocument || document;
  const modal = createDetached(activeDoc, 'div');
  modal.className = 'ai-chat-session-history-modal';

  modal.createDiv({ cls: 'modal-bg' });
  const modalContent = modal.createDiv({ cls: 'modal-content' });
  const modalHeader = modalContent.createDiv({ cls: 'modal-header' });
  modalHeader.createEl('h3', { text: 'Chat sessions' });
  const closeBtn = modalHeader.createEl('button', { cls: 'close-btn', attr: { title: 'Close' } });
  setIcon(closeBtn, 'x');

  const searchContainer = modalContent.createDiv({ cls: 'session-search-container' });
  const searchInput = searchContainer.createEl('input', { 
    type: 'text', 
    cls: 'session-search-input', 
    placeholder: 'Search sessions by name or message content...' 
  });
  searchContainer.createSpan({ cls: 'search-icon', text: '🔍' });

  const sessionList = modalContent.createDiv({ cls: 'session-list' });
  const paginationDiv = modalContent.createDiv({ cls: 'session-pagination nl-display-none' });
  const prevBtn = paginationDiv.createEl('button', { cls: 'prev-page-btn', text: 'Previous' });
  const pageInfo = paginationDiv.createSpan({ cls: 'page-info' });
  const nextBtn = paginationDiv.createEl('button', { cls: 'next-page-btn', text: 'Next' });

  activeDoc.body.appendChild(modal);

  closeBtn.addEventListener('click', () => {
    modal.remove();
  });

  let currentPage = 0;
  const pageSize = 20;
  let totalSessions = 0;
  let currentSearchQuery = '';
  let searchTimeout: number | null = null;

  const loadPage = async (page: number, searchQuery: string = '') => {
    sessionList.empty();
    sessionList.createDiv({ cls: 'loading-sessions', text: 'Searching...' });
    const offset = page * pageSize;
    const { sessions, total } = await options.aiChatSessionManager.listSessionsLazy(pageSize, offset, searchQuery);
    totalSessions = total;

    sessionList.empty();
    if (sessions.length === 0) {
      if (searchQuery) {
        const noSessions = sessionList.createDiv({ cls: 'no-sessions-message' });
        noSessions.appendText(`No sessions found matching "${searchQuery}"`);
        noSessions.createEl('br');
        noSessions.createEl('small', { text: 'Searched in session names and message content' });
      } else if (page === 0) {
        sessionList.createDiv({ cls: 'no-sessions-message', text: 'No sessions yet.' });
      }
      paginationDiv.addClass('nl-display-none');
    } else {
      const fragment = createFragment();
      sessions.forEach(meta => {
        const card = createDetached(activeDoc, 'div');
        card.className = 'session-card';

        const sessionInfo = card.createDiv({ cls: 'session-info' });
        const nameSpan = sessionInfo.createSpan({ cls: 'session-name' });

        if (searchQuery) {
          const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
          const parts = meta.name.split(regex);
          parts.forEach(part => {
            if (part.toLowerCase() === searchQuery.toLowerCase()) {
              nameSpan.createEl('mark', { text: part });
            } else {
              nameSpan.appendText(part);
            }
          });
        } else {
          nameSpan.textContent = meta.name;
        }

        if (searchQuery && meta.matchCount !== undefined) {
          if (meta.matchCount === -1) {
            const matchIndicator = sessionInfo.createSpan({ 
              cls: 'match-indicator name-match', 
              text: '📝 Name match' 
            });
            matchIndicator.setAttr('title', 'Match found in session name');
          } else if (meta.matchCount > 0) {
            const plural = meta.matchCount === 1 ? 'message' : 'messages';
            const matchIndicator = sessionInfo.createSpan({ 
              cls: 'match-indicator content-match', 
              text: `💬 ${meta.matchCount} ${plural}` 
            });
            matchIndicator.setAttr('title', `${meta.matchCount} ${plural} contain your search term`);
          }
        }

        card.createSpan({ 
          cls: 'session-date', 
          text: new Date(meta.updatedAt).toLocaleString() 
        });

        card.addEventListener('click', () => {
          void (async () => {
            const isAgentSession = meta.sessionType === 'agent';

            modal.remove();
            if (isAgentSession) {
              await options.onLoadAgentSession(meta.id);
            } else {
              await options.onLoadChatSession(meta.id);
            }
          })();
        });

        const deleteBtn = createDetached(activeDoc, 'button');
        deleteBtn.className = 'delete-session-btn';
        setIcon(deleteBtn, 'trash-2');
        deleteBtn.title = 'Delete session';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          options.aiChatSessionManager.deleteSession(meta.id).then(() => {
            card.remove();
            totalSessions--;
            updatePagination();
            if (sessionList.querySelectorAll('.session-card').length === 0 && currentPage > 0) {
              currentPage--;
              return loadPage(currentPage, currentSearchQuery);
            }
          }).catch(console.error);
        });
        card.appendChild(deleteBtn);
        fragment.appendChild(card);
      });
      sessionList.appendChild(fragment);

      if (totalSessions > pageSize) {
        paginationDiv.addClass('nl-display-flex');
        updatePagination();
      } else {
        paginationDiv.addClass('nl-display-none');
      }
    }
  };

  const updatePagination = () => {
    const totalPages = Math.ceil(totalSessions / pageSize);
    const searchSuffix = currentSearchQuery ? ' (filtered)' : '';
    pageInfo.textContent = `Page ${currentPage + 1} of ${totalPages} (${totalSessions} sessions${searchSuffix})`;
    prevBtn.disabled = currentPage === 0;
    nextBtn.disabled = currentPage >= totalPages - 1;
  };

  prevBtn.addEventListener('click', () => {
    if (currentPage > 0) {
      currentPage--;
      loadPage(currentPage, currentSearchQuery).catch(console.error);
    }
  });

  nextBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(totalSessions / pageSize);
    if (currentPage < totalPages - 1) {
      currentPage++;
      loadPage(currentPage, currentSearchQuery).catch(console.error);
    }
  });

  searchInput.addEventListener('input', () => {
    if (searchTimeout) window.clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => {
      currentSearchQuery = searchInput.value.trim();
      currentPage = 0;
      loadPage(currentPage, currentSearchQuery).catch(console.error);
    }, 300);
  });

  void loadPage(0, '');
  return modal;
}
