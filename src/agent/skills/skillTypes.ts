export interface SkillMetadata {
  name: string;
  description: string;
}

export interface Skill {
  metadata: SkillMetadata;
  directory: string;
  enabled: boolean;
  builtin: boolean;
  installedByAgent: boolean;
  installedAt: number;
  instructions?: string;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}
