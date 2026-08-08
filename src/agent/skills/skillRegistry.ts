import { normalizePath, type App } from 'obsidian';
import type { Skill } from './skillTypes';
import { parseSkillFile } from './skillParser';

const SKILLS_DIR = '.Nexus-LM-data/skills';

export class SkillRegistry {
  private app: App;
  private pluginDir: string;
  private skills: Map<string, Skill> = new Map();
  private enabledSet: Set<string> = new Set();

  constructor(app: App, pluginDir: string) {
    this.app = app;
    this.pluginDir = pluginDir;
  }

  async discover(): Promise<void> {
    this.skills.clear();

    // 1. Copy built-in skills from plugin dir to .Nexus-LM-data/skills/ if not already there
    await this.copyBuiltInSkills();

    // 2. Discover all skills from .Nexus-LM-data/skills/ (copied built-ins + user + agent-created)
    await this.discoverFromDir(normalizePath(SKILLS_DIR), false, false);
  }

  private async copyBuiltInSkills(): Promise<void> {
    if (!this.pluginDir) return;
    const adapter = this.app.vault.adapter;
    const builtinDir = normalizePath(`${this.pluginDir}/skills`);
    const builtinExists = await adapter.exists(builtinDir);
    if (!builtinExists) return;

    try {
      await adapter.mkdir(normalizePath(SKILLS_DIR));
      const entries = await adapter.list(builtinDir);
      const skillDirs = entries.folders.filter(f => f !== builtinDir);

      for (const skillDir of skillDirs) {
        const skillName = skillDir.split('/').pop() || skillDir.split('\\').pop() || '';
        if (!skillName) continue;

        const targetDir = normalizePath(`${SKILLS_DIR}/${skillName}`);
        const targetExists = await adapter.exists(targetDir);
        if (targetExists) continue;

        const sourceMd = normalizePath(`${skillDir}/SKILL.md`);
        const sourceMdExists = await adapter.exists(sourceMd);
        if (!sourceMdExists) continue;

        const content = await adapter.read(sourceMd);
        await adapter.mkdir(targetDir);
        await adapter.write(normalizePath(`${targetDir}/SKILL.md`), content);
      }
    } catch (err) {
      console.warn('[SkillRegistry] error copying built-in skills:', err);
    }
  }

  private async discoverFromDir(dir: string, builtin: boolean, installedByAgent: boolean): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(dir);
      if (!exists) return;

      const entries = await adapter.list(dir);
      const skillDirs = entries.folders.filter(f => f !== dir);

      for (const skillDir of skillDirs) {
        const skillName = skillDir.split('/').pop() || skillDir.split('\\').pop() || '';
        if (!skillName) continue;

        const skillMdPath = normalizePath(`${skillDir}/SKILL.md`);
        const skillMdExists = await adapter.exists(skillMdPath);
        if (!skillMdExists) continue;

        try {
          const content = await adapter.read(skillMdPath);
          const parsed = parseSkillFile(content, skillMdPath);

          if (parsed.errors.length > 0) {
            for (const err of parsed.errors) {
              console.warn(`[SkillRegistry] ${err}`);
            }
          }

          if (!parsed.metadata.name) {
            parsed.metadata.name = skillName;
          }

          if (!/^[a-z0-9-]+$/.test(parsed.metadata.name) || parsed.metadata.name.length > 64 || !parsed.metadata.description || parsed.metadata.description.length > 1024) {
            console.warn(`[SkillRegistry] skipping invalid skill at ${skillDir}`);
            continue;
          }

          const refsDir = normalizePath(`${skillDir}/references`);
          const scriptsDir = normalizePath(`${skillDir}/scripts`);
          const assetsDir = normalizePath(`${skillDir}/assets`);

          const hasRefs = await adapter.exists(refsDir);
          const hasScripts = await adapter.exists(scriptsDir);
          const hasAssets = await adapter.exists(assetsDir);

          const skill: Skill = {
            metadata: parsed.metadata,
            directory: skillDir,
            enabled: this.enabledSet.has(parsed.metadata.name) || false,
            builtin,
            installedByAgent,
            installedAt: Date.now(),
            instructions: undefined,
            hasScripts,
            hasReferences: hasRefs,
            hasAssets,
          };

          // User skills override built-in skills with the same name
          const existing = this.skills.get(skill.metadata.name);
          if (!existing || !existing.builtin || builtin === false) {
            this.skills.set(skill.metadata.name, skill);
          }
        } catch (err) {
          console.warn(`[SkillRegistry] error reading skill at ${skillDir}:`, err);
        }
      }
    } catch {
      // Directory doesn't exist yet, that's fine
    }
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  getEnabled(): Skill[] {
    return this.getAll().filter(s => s.enabled);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  enable(name: string): void {
    const skill = this.skills.get(name);
    if (skill) {
      skill.enabled = true;
      this.enabledSet.add(name);
    }
  }

  disable(name: string): void {
    const skill = this.skills.get(name);
    if (skill) {
      skill.enabled = false;
      this.enabledSet.delete(name);
    }
  }

  isEnabled(name: string): boolean {
    const skill = this.skills.get(name);
    return skill ? skill.enabled : false;
  }

  setEnabledList(names: string[]): void {
    this.enabledSet = new Set(names);
    for (const skill of this.skills.values()) {
      skill.enabled = this.enabledSet.has(skill.metadata.name);
    }
  }

  async loadInstructions(name: string): Promise<string | null> {
    const skill = this.skills.get(name);
    if (!skill) return null;

    if (skill.instructions !== undefined) {
      return skill.instructions;
    }

    try {
      const adapter = this.app.vault.adapter;
      const skillMdPath = normalizePath(`${skill.directory}/SKILL.md`);
      const exists = await adapter.exists(skillMdPath);
      if (!exists) return null;

      const content = await adapter.read(skillMdPath);
      const parsed = parseSkillFile(content, skillMdPath);
      skill.instructions = parsed.instructions || '';
      return skill.instructions;
    } catch {
      return null;
    }
  }

  async useSkill(name: string): Promise<string | null> {
    const skill = this.skills.get(name);
    if (!skill?.enabled) return null;
    return this.loadInstructions(name);
  }

  getAvailableSkillsSummary(): string {
    const enabled = this.getEnabled();
    if (enabled.length === 0) return '';

    return enabled
      .map(s => `- ${s.metadata.name}: ${s.metadata.description}`)
      .join('\n');
  }

  async createSkillFromAgent(
    name: string,
    description: string,
    instructions: string,
    scripts?: Record<string, string>
  ): Promise<Skill> {
    if (!name || !/^[a-z0-9-]+$/.test(name) || name.length > 64) {
      throw new Error(`Invalid skill name "${name}". Must be lowercase alphanumeric with hyphens, max 64 chars.`);
    }
    if (!description || description.length > 1024) {
      throw new Error(`Invalid skill description. Must be 1-1024 characters.`);
    }
    if (!instructions.trim()) {
      throw new Error('Skill instructions must not be empty.');
    }

    const adapter = this.app.vault.adapter;
    const skillDir = normalizePath(`${SKILLS_DIR}/${name}`);

    const dirExists = await adapter.exists(skillDir);
    if (dirExists) {
      throw new Error(`Skill "${name}" already exists at ${skillDir}. Delete it first or choose a different name.`);
    }

    await adapter.mkdir(normalizePath(SKILLS_DIR));
    await adapter.mkdir(skillDir);

    const skillMdContent = `---
name: ${JSON.stringify(name)}
description: ${JSON.stringify(description)}
---

${instructions.trim()}
`;
    await adapter.write(normalizePath(`${skillDir}/SKILL.md`), skillMdContent);

    if (scripts) {
      const scriptsDir = normalizePath(`${skillDir}/scripts`);
      await adapter.mkdir(scriptsDir);
      for (const [filename, code] of Object.entries(scripts)) {
        await adapter.write(normalizePath(`${scriptsDir}/${filename}`), code);
      }
    }

    await this.discover();

    const created = this.skills.get(name);
    if (created) {
      created.installedByAgent = true;
      created.enabled = true;
      this.enabledSet.add(name);
    }

    return created || this.skills.get(name)!;
  }
}
