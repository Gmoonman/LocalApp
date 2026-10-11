interface Project {
  id: string;
  name: string;
}
export interface ConversationHostProps {
  attachments?: Array<{ id: string; name: string; size: number; path?: string }>;
  sessions: Array<{ id: string; createdAt: string; title?: string;pinned?:boolean }>;
  selectedSession: string;
  projects: Project[];
  project: Project | null;
  files: string[];
  file: { path: string; content: string } | null;
  text: string;
  prompt: string;
  messages: any[];
  live: string;
  running: boolean;
  pending: boolean;
  error: string;
  versions: Array<{ id: string; message: string }>;
  version: string;
  changes: any[];
  providers: Array<{ id: string; name: string; model: string }>;
  provider: string;
  build: any;
  log: string;
  interaction: any;
  answer: string;
  actions: {
    nativeComposerReady?: (port: { request(action: "submit", prompt?: string): Promise<void> } | null) => void;
    nativeActivity?: (sessionId: string, running: boolean) => void;
    upload?: (files: FileList | null) => void;
    removeAttachment?: (id: string) => void;
    select: (p: Project) => void;
    selectSession: (id: string) => void;
    create: (name: string) => void;
    open: (path: string) => void;
    setText: (s: string) => void;
    save: () => void;
    setPrompt: (s: string) => void;
    run: () => void;
    stop: () => void;
    setProvider: (id: string) => void;
    newSession: () => void;
    setVersion: (id: string) => void;
    diff: () => void;
    restore: () => void;
    build: () => void;
    preview: () => void;
    publish: () => void;
    cancelBuild: () => void;
    newFile: (path: string) => void;
    respond: (r: unknown) => void;
    setAnswer: (s: string) => void;
  };
}

/** Compatibility name for development adapters. */
export type DevelopmentShellProps = ConversationHostProps;
