const AGE_DECLARATIONS = [
  /\b(?:i\s*(?:am|'m)|im)\s+(?:only\s+)?([1-9]|1[0-7])\b(?:\s*(?:years?|yrs?)\s*old)?/i,
  /\b(?:my\s+age\s+is|age\s*[:=-]?)\s*([1-9]|1[0-7])\b/i,
  /^\s*(?:only\s+)?([1-9]|1[0-7])\s*(?:years?|yrs?)\s*old\b/i,
];

export function declaredUnderage(message) {
  if (typeof message !== 'string') return false;
  return AGE_DECLARATIONS.some(pattern => pattern.test(message));
}
