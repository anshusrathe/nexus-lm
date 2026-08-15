/**
 * MCP Server Registry
 * Curated list of popular MCP servers with pre-filled configuration templates.
 *
 * VERIFICATION POLICY: Every entry in this file has been manually verified
 * against the official npm registry, PyPI, or the server's official docs.
 * Do NOT add entries based on guesses — confirm the package name exists and
 * the runtime (npx vs uvx) is correct before adding.
 *
 * Runtime guide:
 *   npx  → JavaScript/Node.js package published to npmjs.com
 *   uvx  → Python package published to PyPI (requires `uv` installed)
 *   url  → Remote SSE/HTTP server (no local process needed)
 */

export interface MCPEnvVarSpec {
  key: string;
  label: string;
  description: string;
  placeholder: string;
  required: boolean;
  link?: string;
  /**
   * Optional template to wrap the user's raw input before storing it as the env value.
   * Use `{{value}}` as the placeholder for the user's input.
   * Example: '{"Authorization": "Bearer {{value}}", "Notion-Version": "2022-06-28"}'
   */
  valueTemplate?: string;
}

export interface MCPPathSpec {
  argPlaceholder: string;
  label: string;
  description: string;
  required: boolean;
  isVaultPath?: boolean;
  isRepoPath?: boolean;
  isFilePath?: boolean;
  fileExtension?: string;
}

export interface MCPRegistryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  envVarSpecs?: MCPEnvVarSpec[];
  pathSpecs?: MCPPathSpec[];
  staticEnv?: Record<string, string>;
  docsUrl?: string;
}

export const MCP_CATEGORIES = [
  'All',
  'AI & Search',
  'Developer Tools',
  'Databases',
  'Productivity',
  'File System',
  'Communication',
  'Finance & Data',
  'Diagramming',
  'Research',
  'Project Management',
];

export const MCP_REGISTRY: MCPRegistryEntry[] = [

  

  {
    
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search using the Brave Search API.',
    category: 'AI & Search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envVarSpecs: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API Key',
        description: 'Your Brave Search API key. Get one for free at the Brave Search developer portal.',
        placeholder: 'BSA...',
        required: true,
        link: 'https://brave.com/search/api/',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },

  {
    
    id: 'perplexity-search',
    name: 'Perplexity Search',
    description: 'AI-powered web search via Perplexity Sonar API.',
    category: 'AI & Search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-perplexity-ask'],
    envVarSpecs: [
      {
        key: 'PERPLEXITY_API_KEY',
        label: 'Perplexity API Key',
        description: 'Your Perplexity API key. Find it in your Perplexity account settings under API.',
        placeholder: 'pplx-...',
        required: true,
        link: 'https://www.perplexity.ai/settings/api',
      },
    ],
    docsUrl: 'https://github.com/ppl-ai/modelcontextprotocol',
  },

  {
    
    //
    
    
    
    
    //
    
    
    id: 'exa-search',
    name: 'Exa Search',
    description: 'Neural search engine for web, code, and company research. Uses the official Exa hosted MCP — no local install needed.',
    category: 'AI & Search',
    transport: 'sse',
    url: 'https://mcp.exa.ai/mcp',
    envVarSpecs: [
      {
        key: 'EXA_API_KEY',
        label: 'Exa API Key',
        description: 'Optional but recommended — removes rate limits. Get a free key from the Exa dashboard. The key can be any format (no specific prefix required).',
        placeholder: 'your-exa-api-key',
        required: false,
        link: 'https://dashboard.exa.ai/api-keys',
      },
    ],
    docsUrl: 'https://docs.exa.ai/examples/exa-mcp',
  },

  {
    
    id: 'fetch',
    name: 'Web Fetch',
    description: 'Fetch any URL and convert it to clean Markdown. Pull web content, docs, or articles into your notes.',
    category: 'AI & Search',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },

  {
    
    id: 'time',
    name: 'Time & Timezone',
    description: 'Get the current time in any IANA timezone and convert between timezones.',
    category: 'AI & Search',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  },

  

  {
    
    id: 'github',
    name: 'GitHub',
    description: 'Interact with GitHub repos, issues, PRs, and code search.',
    category: 'Developer Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envVarSpecs: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub Personal Access Token',
        description: 'A GitHub PAT with repo and read:org scopes. Create one in GitHub Settings → Developer settings → Personal access tokens.',
        placeholder: 'ghp_...',
        required: true,
        link: 'https://github.com/settings/tokens/new',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },

  {
    
    id: 'memory',
    name: 'Memory (Knowledge Graph)',
    description: 'Persistent memory store using a local knowledge graph. No API key needed.',
    category: 'Developer Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },

  {
    
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning tool. No API key needed.',
    category: 'Developer Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },

  {
    
    id: 'playwright',
    name: 'Playwright (Browser)',
    description: 'Control a real browser — navigate pages, click, fill forms, take screenshots.',
    category: 'Developer Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
  },

  {
    
    id: 'puppeteer',
    name: 'Puppeteer (Browser)',
    description: 'Headless Chrome automation for web scraping and screenshots.',
    category: 'Developer Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },

  {
    
    id: 'git',
    name: 'Git',
    description: 'Read history, diffs, commits, branches, and blame from any local Git repository.',
    category: 'Developer Tools',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '/path/to/your/repo'],
    pathSpecs: [
      {
        argPlaceholder: '/path/to/your/repo',
        label: 'Git Repository Path',
        description: 'The absolute path to the local Git repository you want the AI to read.',
        required: true,
        isRepoPath: true,
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },

  {
    
    id: 'sentry',
    name: 'Sentry',
    description: 'Retrieve and analyse error issues, stack traces, and events from your Sentry projects.',
    category: 'Developer Tools',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sentry'],
    envVarSpecs: [
      {
        key: 'SENTRY_AUTH_TOKEN',
        label: 'Sentry Auth Token',
        description: 'A Sentry internal integration token with read access to issues. Create one in Sentry → Settings → Developer Settings → Internal Integrations.',
        placeholder: 'sntrys_...',
        required: true,
        link: 'https://sentry.io/settings/',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sentry',
  },

  

  {
    
    id: 'filesystem',
    name: 'File System',
    description: 'Read and write files on your local machine within an allowed directory.',
    category: 'File System',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
    pathSpecs: [
      {
        argPlaceholder: '/path/to/allowed/dir',
        label: 'Allowed Directory',
        description: 'The root directory the server is allowed to access. The AI can read and write any file inside this folder.',
        required: true,
        isVaultPath: true,
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },

  

  {
    
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and inspect a PostgreSQL database.',
    category: 'Databases',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envVarSpecs: [
      {
        key: 'POSTGRES_CONNECTION_STRING',
        label: 'PostgreSQL Connection String',
        description: 'Your database connection URL. Format: postgresql://user:password@host:5432/dbname',
        placeholder: 'postgresql://user:password@localhost:5432/mydb',
        required: true,
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },

  {
    
    
    
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query a local SQLite database file. Requires uv (Python package manager).',
    category: 'Databases',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '/path/to/your.db'],
    pathSpecs: [
      {
        argPlaceholder: '/path/to/your.db',
        label: 'SQLite Database File Path',
        description: 'The absolute path to your .db file.',
        required: true,
        isFilePath: true,
        fileExtension: '.db',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },

  {
    
    id: 'supabase',
    name: 'Supabase',
    description: 'Manage your Supabase project — database, auth, storage, and more.',
    category: 'Databases',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@supabase/mcp-server-supabase@latest'],
    envVarSpecs: [
      {
        key: 'SUPABASE_ACCESS_TOKEN',
        label: 'Supabase Access Token',
        description: 'Your Supabase personal access token. Find it in Supabase Dashboard → Account → Access Tokens.',
        placeholder: 'sbp_...',
        required: true,
        link: 'https://supabase.com/dashboard/account/tokens',
      },
    ],
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
  },

  

  {
    
    //
    
    
    
    
    
    
    
    
    
    
    //
    
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Search and read files from Google Drive. Requires a one-time OAuth setup via Google Cloud Console before connecting.',
    category: 'Productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    envVarSpecs: [
      {
        key: 'GDRIVE_OAUTH_PATH',
        label: 'OAuth Keys File Path',
        description: 'Step 1: In Google Cloud Console, create a project, enable the Drive API, and create an OAuth Client ID (Desktop App). Download the JSON key file and save it somewhere on your machine. Step 2: Paste the absolute path to that file here (e.g. C:\\Users\\you\\gcp-oauth.keys.json). Step 3: After adding this server, run the one-time auth command in a terminal: npx -y @modelcontextprotocol/server-gdrive auth — this opens a browser OAuth flow and saves your credentials.',
        placeholder: 'C:\\Users\\you\\gcp-oauth.keys.json',
        required: true,
        link: 'https://console.cloud.google.com/apis/credentials',
      },
      {
        key: 'GDRIVE_CREDENTIALS_PATH',
        label: 'Credentials Storage Path',
        description: 'Absolute path where the OAuth credentials will be saved after the auth flow (e.g. C:\\Users\\you\\.gdrive-server-credentials.json). Must match the path used when you ran the auth command.',
        placeholder: 'C:\\Users\\you\\.gdrive-server-credentials.json',
        required: true,
        link: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
  },

  {
    
    //
    
    
    
    
    //
    
    
    
    
    id: 'notion',
    name: 'Notion',
    description: 'Read and write Notion pages and databases via the official Notion MCP server. Requires a Notion internal integration token.',
    category: 'Productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    envVarSpecs: [
      {
        key: 'OPENAPI_MCP_HEADERS',
        label: 'Notion Integration Token',
        description: 'Step 1: Go to notion.so/profile/integrations → "New integration" → copy the secret (starts with ntn_). Step 2: Open each Notion page/database you want accessible → click ··· → Connections → select your integration. Step 3: Paste your token below — it will be wrapped into the required header format automatically.',
        placeholder: 'ntn_...',
        required: true,
        link: 'https://www.notion.so/profile/integrations',
        valueTemplate: '{"Authorization": "Bearer {{value}}", "Notion-Version": "2022-06-28"}',
      },
    ],
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
  },

  {
    
    id: 'google-maps',
    name: 'Google Maps',
    description: 'Geocode addresses, search places, get directions, and look up location details.',
    category: 'Productivity',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    envVarSpecs: [
      {
        key: 'GOOGLE_MAPS_API_KEY',
        label: 'Google Maps API Key',
        description: 'A Google Maps Platform API key with the Maps, Places, and Directions APIs enabled. Create one in the Google Cloud Console.',
        placeholder: 'AIza...',
        required: true,
        link: 'https://console.cloud.google.com/apis/credentials',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps',
  },

  {
    id: 'mcp-obsidian',
    name: 'Obsidian (Local REST API)',
    description: 'Interact with your Obsidian vault via the Local REST API plugin. Allows listing, reading, searching, and patching notes. Requires the "Local REST API" community plugin to be installed and active.',
    category: 'Productivity',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-obsidian'],
    envVarSpecs: [
      {
        key: 'OBSIDIAN_API_KEY',
        label: 'API Key',
        description: 'The API key generated by the Local REST API plugin.',
        placeholder: 'your-api-key',
        required: true,
      },
      {
        key: 'OBSIDIAN_HOST',
        label: 'Host (Optional)',
        description: 'The IP address Obsidian is running on.',
        placeholder: '127.0.0.1',
        required: false,
      },
      {
        key: 'OBSIDIAN_PORT',
        label: 'Port (Optional)',
        description: 'The port the Local REST API is listening on.',
        placeholder: '27124',
        required: false,
      },
    ],
    docsUrl: 'https://github.com/MarkusPfundstein/mcp-obsidian',
  },

  

  {
    
    id: 'slack',
    name: 'Slack',
    description: 'Read messages and post to Slack channels.',
    category: 'Communication',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envVarSpecs: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Slack Bot Token',
        description: 'Your Slack bot OAuth token. Create a Slack app at api.slack.com/apps, add bot scopes, install it to your workspace, and copy the Bot User OAuth Token.',
        placeholder: 'xoxb-...',
        required: true,
        link: 'https://api.slack.com/apps',
      },
      {
        key: 'SLACK_TEAM_ID',
        label: 'Slack Team/Workspace ID',
        description: 'Your Slack workspace ID. Find it in your Slack workspace URL: https://app.slack.com/client/TXXXXXXXX — the part starting with T.',
        placeholder: 'T0123456789',
        required: true,
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },

  

  {
    
    id: 'aws-kb-retrieval',
    name: 'AWS Knowledge Base',
    description: 'Retrieve information from AWS Bedrock Knowledge Bases.',
    category: 'Finance & Data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-aws-kb-retrieval'],
    envVarSpecs: [
      {
        key: 'AWS_ACCESS_KEY_ID',
        label: 'AWS Access Key ID',
        description: 'Your AWS access key ID. Create one in AWS Console → IAM → Users → Security credentials.',
        placeholder: 'AKIA...',
        required: true,
        link: 'https://console.aws.amazon.com/iam/',
      },
      {
        key: 'AWS_SECRET_ACCESS_KEY',
        label: 'AWS Secret Access Key',
        description: 'Your AWS secret access key (shown only once when created).',
        placeholder: 'wJalrXUtnFEMI...',
        required: true,
      },
      {
        key: 'AWS_REGION',
        label: 'AWS Region',
        description: 'The AWS region where your Knowledge Base is deployed (e.g., us-east-1).',
        placeholder: 'us-east-1',
        required: true,
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/aws-kb-retrieval-server',
  },

  

  {
    
    id: 'clear-thought',
    name: 'Clear Thought',
    description: 'Structured thinking tools: sequential reasoning, mental models (First Principles, Occam\'s Razor, Pareto), design patterns, debugging approaches, and programming paradigms.',
    category: 'Developer Tools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@waldzellai/clear-thought'],
    docsUrl: 'https://github.com/waldzellai/waldzell-mcp/tree/main/servers/server-clear-thought',
  },

  

  {
    
    
    
    //
    
    
    //
    
    
    
    //
    
    
    
    //
    
    
    //
    
    
    id: 'excalidraw-local',
    name: 'Excalidraw (Local Canvas)',
    description: 'Free, no API key. 26 AI tools — draw, edit, export, Mermaid conversion, shareable links.\n\n⚠️ Before clicking Configure, start the canvas server first:\n• Docker: docker run -d -p 3000:3000 ghcr.io/yctimlin/mcp_excalidraw-canvas:latest\n• No Docker: git clone https://github.com/yctimlin/mcp_excalidraw.git → npm install && npm run build && npm run canvas\n\nThen open http://localhost:3000 to confirm the canvas is live, and click Configure.',
    category: 'Diagramming',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'excalidraw-mcp'],
    staticEnv: {
      ENABLE_CANVAS_SYNC: 'true',
      EXPRESS_SERVER_URL: 'http://localhost:3000',
    },
    docsUrl: 'https://github.com/yctimlin/mcp_excalidraw',
  },

  {
    
    
    
    //
    
    
    
    
    id: 'excalidraw',
    name: 'Excalidraw+ (Paid)',
    description: 'Generate hand-drawn diagrams via the official Excalidraw+ remote MCP. Requires an Excalidraw+ subscription and API key. For a free local option use "Excalidraw (Local Canvas)" above.',
    category: 'Diagramming',
    transport: 'sse',
    url: 'https://api.excalidraw.com/api/v1/mcp',
    envVarSpecs: [
      {
        key: 'EXCALIDRAW_API_KEY',
        label: 'Excalidraw+ API Key',
        description: 'Your Excalidraw+ API key. Create one in your Excalidraw+ account settings.',
        placeholder: 'ex_...',
        required: true,
        link: 'https://plus.excalidraw.com/docs',
      },
    ],
    docsUrl: 'https://plus.excalidraw.com/docs/mcp',
  },

  {
    
    id: 'antv-chart',
    name: 'AntV Chart Generator',
    description: 'Generate 26+ interactive chart types (bar, line, pie, sankey, treemap, mind map, flowchart, word cloud, and more) from data using the AntV visualization library.',
    category: 'Diagramming',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@antv/mcp-server-chart'],
    docsUrl: 'https://github.com/antvis/mcp-server-chart',
  },

  {
    
    id: 'mcp-dashboards',
    name: 'MCP Dashboards',
    description: 'Render 31 interactive chart types and full dashboards (bar, line, pie, scatter, heatmap, geo map, KPI widgets, live polling, and more) directly inside your AI conversation.',
    category: 'Diagramming',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-dashboards', '--stdio'],
    docsUrl: 'https://github.com/KyuRish/mcp-dashboards',
  },

  

  {
    
    
    id: 'arxiv',
    name: 'arXiv Papers',
    description: 'Search, download, and analyse academic papers from arXiv. Requires uv (Python package manager).',
    category: 'Research',
    transport: 'stdio',
    command: 'uv',
    args: ['tool', 'run', 'arxiv-mcp-server', '--storage-path', '/path/to/arxiv/storage'],
    pathSpecs: [
      {
        argPlaceholder: '/path/to/arxiv/storage',
        label: 'Paper Storage Path',
        description: 'A local folder where downloaded arXiv papers will be saved. Will be created if it does not exist.',
        required: true,
        isFilePath: false,
      },
    ],
    docsUrl: 'https://github.com/blazickjp/arxiv-mcp-server',
  },

  

  {
    
    
    
    id: 'linear',
    name: 'Linear',
    description: 'Official Linear remote MCP — search, create, and update issues, projects, and comments. No local install needed.',
    category: 'Project Management',
    transport: 'sse',
    url: 'https://mcp.linear.app/mcp',
    docsUrl: 'https://linear.app/docs/mcp',
  },

  {
    
    id: 'atlassian',
    name: 'Jira & Confluence (Atlassian)',
    description: 'Official Atlassian remote MCP — read and update Jira issues and Confluence pages.',
    category: 'Project Management',
    transport: 'sse',
    url: 'https://mcp.atlassian.com/v1/sse',
    envVarSpecs: [
      {
        key: 'ATLASSIAN_API_TOKEN',
        label: 'Atlassian API Token',
        description: 'Your Atlassian account API token. Create one at id.atlassian.com → Security → API tokens.',
        placeholder: 'ATATT3x...',
        required: true,
        link: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      },
    ],
    docsUrl: 'https://github.com/atlassian/atlassian-mcp-server',
  },
];
