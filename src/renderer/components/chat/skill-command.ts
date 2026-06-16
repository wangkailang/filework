export interface SkillCommandItem {
  id: string;
  name: string;
  description: string;
  source: string;
}

export interface ActiveSkillSlash {
  query: string;
  from: number;
}

export const SKILL_MENTION_TEXT_MARKER = "\ufffc";

const isSelectedSkillToken = (token: string) =>
  token === SKILL_MENTION_TEXT_MARKER || /^\/[^\s/]+$/.test(token);

const findSkillSlashCandidate = (
  textBeforeCursor: string,
): ActiveSkillSlash | null => {
  const from = textBeforeCursor.lastIndexOf("/");
  if (from < 0) return null;

  const query = textBeforeCursor.slice(from + 1);
  if (/[\s/]/.test(query)) return null;

  const prefix = textBeforeCursor.slice(0, from);
  if (prefix && !/\s$/.test(prefix)) return null;

  return {
    query: query.toLowerCase(),
    from,
  };
};

export const findActiveSkillSlash = (
  textBeforeCursor: string,
): ActiveSkillSlash | null => {
  const candidate = findSkillSlashCandidate(textBeforeCursor);
  if (!candidate) return null;

  const prefix = textBeforeCursor.slice(0, candidate.from);
  if (prefix) {
    const trimmedPrefix = prefix.trim();
    if (trimmedPrefix) {
      const firstToken = trimmedPrefix.split(/\s+/, 1)[0];
      if (!isSelectedSkillToken(firstToken)) return null;
    }
  }

  return candidate;
};

export const resolveSkillSlashTextRange = ({
  documentTextBeforeCursor,
  localTextBeforeCursor,
}: {
  documentTextBeforeCursor?: string;
  localTextBeforeCursor: string;
}): ActiveSkillSlash | null => {
  const localCandidate = findSkillSlashCandidate(localTextBeforeCursor);
  if (!localCandidate) return null;

  if (findActiveSkillSlash(localTextBeforeCursor)) return localCandidate;
  if (!documentTextBeforeCursor) return null;

  const documentCandidate = findActiveSkillSlash(documentTextBeforeCursor);
  if (!documentCandidate) return null;
  if (documentCandidate.query !== localCandidate.query) return null;

  return localCandidate;
};

export const filterSkillCommands = (
  skills: SkillCommandItem[],
  query: string,
) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return skills;

  return skills.filter((skill) =>
    [skill.id, skill.name, skill.description].some((field) =>
      field.toLowerCase().includes(normalizedQuery),
    ),
  );
};
