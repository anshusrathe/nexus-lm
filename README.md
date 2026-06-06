

![Main Wallpaper](Assets/Main%20wallpaper%20of%20the%20plugin.png)

> **Supercharge your workspace with 100+ free models:** Chat with your notes, auto-generate interactive study tools, run local or cloud LLMs, manage RSS feeds, and execute code—all without ever leaving Obsidian.

Nexus-LM is the ultimate AI-powered workspace designed exclusively for Obsidian. Instead of just storing your notes, Nexus-LM turns them into an active, conversational partner. Whether you are a researcher, student, developer, or power-user, Nexus-LM bridges the gap between your local knowledge base and state-of-the-art artificial intelligence.

---

## 🚀 Quick Start

1.  **Install** from the Obsidian Community Plugins store (search for `nexus-lm`).
2.  **Configure Your Keys**: Go to **Settings → Nexus-LM → Basic** and add an API key from any of our supported providers (Gemini, Groq, OpenRouter, OpenCode, Nvidia, Mistral, Cohere, or Ollama for local models).
3.  **Launch the Hub**: Click the **pinwheel icon** in the ribbon or run the command `Open Nexus-LM Hub` from the command palette.
4.  **Index Your Vault**: Build a vault index under **Settings → Vault Chat** to unlock lightning-fast semantic search.

---

## 🗺️ Visual Walkthrough & Core Views

The **Nexus-LM Hub** is your central command center. From here, you can jump directly into specialized views tailored to your workflow.

### 1. Nexus Chat (Deep Vault Integration & Extensible Tools)
A full-featured chat with customizable wallpapers, session history, and powerful context-injection commands.

![Vault Search](Assets/vault%20search%20example.png)

#### Context Commands (The `+` Menu)
Type prefixes or click the `+` button to dynamically inject external context into your messages:

| Option            | Prefix     | Description                                                                               |
| :---------------- | :--------- | :---------------------------------------------------------------------------------------- |
| **Vault Search**  | `@vault`   | Hybrid semantic search (Embeddings + BM25) across your vault notes with inline citations. |
| **Flash Search**  | `@flash`   | BM25-only keyword search for ultra-fast exact lookups.                                    |
| **Web Search**    | `@web`     | Real-time web search.                                                                     |
| **YouTube Video** | `@youtube` | Fetch and chat with a YouTube video transcript.                                           |
| **Web Pages**     | `@webpage` | Inject full page content from raw URLs.                                                   |
| **Attach File**   | `@file`    | Add multimodal attachments (Images, PDFs, Audio).                                         |

#### ⚡ Flash Search in Action
Need a quick lookup without waiting for embeddings? Use `@flash` for blazing-fast BM25 keyword matching.

![Flash Search](Assets/flash%20search%20example.png)

#### 🔌 MCP (Model Context Protocol) Support
Extend your chat's capabilities using local or remote MCP servers. Connect over `stdio` or `sse` to allow the AI to add context from any MCP server, interact with local APIs, or use custom developer tools.

![MCP Query](Assets/mcp%20query%20example.png)

---

### 2. Nexus Tutor (Your Personal AI Study Environment)
Transform static notes into interactive learning experiences. Select your notes or entire folders, track live token usage against your model's context window, and generate study material instantly.

#### 📝 Q&A Sessions
Test your comprehension with AI-generated questions based directly on your selected notes. Type your answers and receive instant, color-coded **relevance scoring (0-100%)** alongside constructive, detailed feedback.

![Q&A Example](Assets/QnA%20example.png)

#### 📊 MCQ Sessions
Generate customizable multiple-choice quizzes with timed sessions. When you submit, get an instant grade breakdown and step-by-step explanations for any incorrect answers.

![MCQ Example](Assets/MCQ%20example.png)

#### 🕸️ Interactive Concept Maps
Analyze your notes to generate a gorgeous, interactive SVG concept map. Easily zoom, pan, and click nodes to explore core themes, related topics, and labeled connections.

![Concept Map](Assets/concept%20map%20example.png)

#### 🎭 Zen Slideshows
Reorganize complex topics into beautiful, structured slideshows. Each slide comes with AI-generated narration read aloud via browser Text-to-Speech (TTS) with adjustable speed and auto-advance.

![Slideshow Example](Assets/slideshow%20example.png)

---

### 3. Notebook Chat (Persistent, Source-Tied Sessions)
Tether your chat sessions to a fixed set of sources (notes, folders, web URLs, or RSS feeds).

![Notebook Chat View](Assets/Notebookchatview%20example.png)

Choose between two powerful retrieval strategies:
*   **CAG (Context-Augmented Generation)**: Injects all selected sources in full—ideal for small notebooks where complete context coverage is critical.
*   **RAG (Retrieval-Augmented Generation)**: Leverages query expansion, BM25 indexing, and hierarchical context summaries to retrieve only the most relevant chunks—highly token-efficient for massive datasets. The query however needs to be keyword heavy in order to get the right response.

#### Special Notebook Commands
*   `@quiz`: Generates an interactive inline MCQ quiz.
*   `@flashcards`: Generates study flashcards with active recall tracking (Red/Orange/Green).
*   `@session`: Contextualize your current chat using previous session histories.

---

### 4. Your Feed (Built-in RSS Reader)
Keep up with your favorite blogs, journals, and news directly inside Obsidian. Organize feeds into color-coded folders, bookmark entries for later, and seamlessly import feed items as live context for your Notebooks.

![Feed View](Assets/Feedview%20example.png)

---

## 🛠️ Advanced Tools & Utilities

### 💻 Code Execution & Rich Rendering
Nexus-LM doesn't just display code—it runs it. Code blocks in chat responses feature context-aware execution buttons:
*   **Run Sandboxed**: Execute JavaScript and TypeScript in a secure Web Worker.
*   **Interactive Previews**: Render HTML, CSS, SVG, and Mermaid diagrams directly inside the chat.
*   **Smart JSON Render**: Automatically detects Vega-Lite or Chart.js schemas to display beautiful visual charts.
*   **Obsidian Integration**: Execute Dataview and DataviewJS blocks inline.

![Canvas Example](Assets/canvas%20example.png)

### 📂 File Creation via Chat
When the AI proposes creating files in your vault, Nexus-LM opens a **File Creation Review Modal**. Preview the proposed folder structure, accept/reject files individually, or apply Obsidian templates before writing to disk.

![Create Tool Example](Assets/create%20tool%20example.png)

You can also leverage AI to create new Excalidraw diagrams or Canvas files directly within your vault.

![Create Excalidraw](Assets/create%20excalidraw%20example.png)
![Create Canvas](Assets/create%20canvas%20example.png)

### 📄 PDF Text Extraction
Extract text from any open PDF file. Choose custom page ranges and immediately save the formatted text as a clean markdown file.

![PDF Extraction](Assets/PDF%20extraction%20example.png)

### ✍️ Edit Selection
Easily modify selected text within your notes. Highlight any text and use this tool to ask the AI to summarize, rephrase, translate, or perform other text manipulations.

![Edit Selection](Assets/edit%20selection%20example.png)

---

## ⚙️ Provider & Model Support

Nexus-LM is highly flexible, supporting both local offline models and industry-leading cloud APIs. Configure feature-specific models independently to optimize speed, cost, and context size.

| Provider                    | Chat | Tutor | Notebook | Embeddings | Thinking | Web Search    | YouTube       |
| :-------------------------- | :--: | :---: | :------: | :--------: | :------: | :-----------: | :-----------: |
| **Google Gemini**           | ✅   | ✅    | ✅       | ✅         | ✅       | ✅ (Grounded) | ✅ (Native)   |
| **Groq**                    | ✅   | ✅    | ✅       | ❌         | ✅ (GPT-OSS) | ✅            | ✅ (Transcript) |
| **OpenRouter**              | ✅   | ✅    | ✅       | ✅         | ❌       | ❌            | ✅ (Transcript) |
| **Ollama (Local/Cloud)**    | ✅   | ✅    | ✅       | ✅         | ✅ (GPT-OSS) | ✅            | ✅ (Transcript) |
| **NVIDIA NIM**              | ✅   | ✅    | ✅       | ✅         | ❌       | ❌            | ✅ (Transcript) |
| **OpenCode Zen**            | ✅   | ✅    | ✅       | ❌         | ❌       | ❌            | ✅ (Transcript) |
| **Custom OpenAI-Compatible**| ✅   | ✅    | ✅       | ✅         | ❌       | ❌            | ✅ (Transcript) |

### 🛠️ Custom Model Configuration
Take full control over which models are active in your selector. Enable, disable, and configure custom model endpoints in settings.

![Settings Page](Assets/Settings%20page%20custom%20model%20screenshot.png)

---

## ⚙️ Settings Reference

### Basic Configuration
*   **AI Provider**: Toggle your primary provider.
*   **API Key**: Secure input validation for your provider keys.
*   **Model Discovery**: Plugin tries to fetch the provided models and enable the ones available as per the user API key (Verify Models).

### Vault Chat Settings
*   **Embedding Indexes**: Build and inspect vector databases for semantic search.
*   **BM25 Indexes**: Create keyword indexes to power fast `@flash` searches.
*   **Excluded Folders/Files**: Set patterns to prevent indexing sensitive folders.
*   **BM25 Boosts**: Fine-tune relevance by boosting matches in Titles (default: 3.0), Headings (2.0), or Tags (1.5).

### Miscellaneous Options
*   **YouTube settings**: Decide between the YouTube video processing methods (Transcripts/Gemini native).
*   **Chat Wallpaper**: Set a custom background image with customizable opacity controls.

---

## 🔒 Security & Privacy Disclosures

*   **Local Indexing**: All file indexing (Embeddings & BM25) happens **entirely locally on your device**.
*   **Data Transmission**: Nexus-LM only transmits your note content to external APIs that you explicitly configure and authorize via your API keys. Your files are never uploaded to third-party servers.
*   **Local Storage Paths**:
    *   Index files: `.Nexus-LM-data/`
    *   Notebook cache: `.Nexus-LM-data/notebook-cache/`
    *   Session history: `.Nexus-LM-data/notebook-chat-history/`

---

*Developed with 💜 for the Obsidian Community. Licensed under the [MIT License](/LICENSE).*
