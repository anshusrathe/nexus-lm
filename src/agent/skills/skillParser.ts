import type { SkillMetadata } from './skillTypes';

export interface ParsedSkill {
  metadata: SkillMetadata;
  instructions: string;
  errors: string[];
}

export function parseSkillFile(content: string, filePath: string): ParsedSkill {
  const errors: string[] = [];
  const trimmed = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();

  const frontmatterMatch = trimmed.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    errors.push(`Missing YAML frontmatter in ${filePath}`);
    return {
      metadata: { name: '', description: '' },
      instructions: '',
      errors,
    };
  }

  const yamlBlock = frontmatterMatch[1];
  const instructions = frontmatterMatch[2].trim();

  const metadata = parseYamlFrontmatter(yamlBlock);

  if (!metadata.name) {
    errors.push(`Skill at ${filePath} is missing required field: name`);
  } else if (metadata.name.length > 64) {
    errors.push(`Skill name "${metadata.name}" exceeds 64 characters`);
  } else if (!/^[a-z0-9-]+$/.test(metadata.name)) {
    errors.push(`Skill name "${metadata.name}" must be lowercase alphanumeric with hyphens only`);
  }

  if (!metadata.description) {
    errors.push(`Skill at ${filePath} is missing required field: description`);
  } else if (metadata.description.length > 1024) {
    errors.push(`Skill description exceeds 1024 characters`);
  }

  return { metadata, instructions, errors };
}

function parseYamlFrontmatter(yaml: string): SkillMetadata {
  const metadata: SkillMetadata = {
    name: '',
    description: '',
  };

  const lines = yaml.split('\n');
  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = parseScalar(match[2].trim());

    if (key === 'name') metadata.name = value;
    else if (key === 'description') metadata.description = value;
  }

  return metadata;
}

function parseScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : value;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}
