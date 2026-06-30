import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

const COMMON_LIBRE_OFFICE_PATHS = [
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/opt/homebrew/bin/soffice",
  "/usr/local/bin/soffice",
  "/opt/homebrew/bin/libreoffice",
  "/usr/local/bin/libreoffice",
];

interface ResolveLibreOfficePathOptions {
  env?: Record<string, string | undefined>;
  pathValue?: string;
  commonPaths?: string[];
  exists?: (path: string) => Promise<boolean>;
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const resolveLibreOfficePath = async (
  options: ResolveLibreOfficePathOptions = {},
): Promise<string | undefined> => {
  const env = options.env ?? process.env;
  const explicit = env.FILEWORK_LIBREOFFICE_PATH?.trim();
  if (explicit) return explicit;

  const exists = options.exists ?? fileExists;
  const pathValue = options.pathValue ?? env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const command of ["soffice", "libreoffice"]) {
      const candidate = join(dir, command);
      if (await exists(candidate)) return candidate;
    }
  }

  for (const candidate of options.commonPaths ?? COMMON_LIBRE_OFFICE_PATHS) {
    if (await exists(candidate)) return candidate;
  }

  return undefined;
};
