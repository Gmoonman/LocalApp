const RESERVED_NAMES = new Set([
  "api", "serve", "health", "cli", "keys", "upload", "pages", "schemas",
]);

const NAME_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export function validateName(name: string): string | null {
  if (!name || name.length < 3 || name.length > 63) {
    return "Name must be 3-63 characters";
  }
  if (!NAME_REGEX.test(name)) {
    return "Name must start with a letter, contain only lowercase letters, digits, and hyphens";
  }
  if (name.includes("--")) {
    return "Name must not contain consecutive hyphens";
  }
  if (RESERVED_NAMES.has(name)) {
    return `"${name}" is a reserved name`;
  }
  return null;
}
