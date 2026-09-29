/**
 * Clipboard and Text Utilities for NexDrop.
 * Supports:
 * - Direct clipboard copy & read with fallback
 * - Smart content categorization (code, URL, JSON, plain text)
 */


export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('navigator.clipboard.writeText failed, trying fallback:', err);
    }
  }

  // Fallback for older browsers or restricted permissions
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-999999px';
    textarea.style.top = '-999999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textarea);
    return successful;
  } catch (err) {
    console.error('Fallback copy failed:', err);
    return false;
  }
}

export async function readFromClipboard(): Promise<string | null> {
  if (typeof window === 'undefined' || !navigator.clipboard) return null;
  try {
    return await navigator.clipboard.readText();
  } catch (err) {
    console.warn('Clipboard read failed (permission denied or unsupported):', err);
    return null;
  }
}

export function detectContentCategory(text: string): {
  category: 'plain' | 'code' | 'url' | 'json';
  language?: string;
} {
  const trimmed = text.trim();

  // 1. URL check
  if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
    return { category: 'url' };
  }

  // 2. JSON check
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return { category: 'json', language: 'json' };
      }
    } catch (e) {
      // not valid JSON
    }
  }

  // 3. Code Detection heuristics
  const codeIndicators: Array<{ regex: RegExp; lang: string }> = [
    { regex: /<(!DOCTYPE|html|div|span|script|template|body|p)[\s>]/i, lang: 'html' },
    { regex: /(@import|@media|(?:\.|\#)[\w-]+\s*\{[^}]*\})/i, lang: 'css' },
    { regex: /(import\s+.*from\s+['"]|export\s+(default\s+)?(function|const|class)|interface\s+\w+|type\s+\w+\s*=)/, lang: 'typescript' },
    { regex: /(function\s+\w+\s*\(|const\s+\w+\s*=\s*\(|console\.log\()/, lang: 'javascript' },
    { regex: /(def\s+\w+\(.*\):|class\s+\w+:|import\s+\w+|from\s+\w+\s+import)/, lang: 'python' },
    { regex: /(SELECT\s+.*FROM\s+|INSERT\s+INTO\s+|UPDATE\s+.*SET\s+|CREATE\s+TABLE\s+)/i, lang: 'sql' },
    { regex: /(#!\/bin\/(bash|sh)|curl\s+-|apt-get\s+|docker\s+run|npm\s+(install|run)|git\s+(commit|push|checkout))/, lang: 'bash' },
    { regex: /(#\s+.+\n|\*\*|\!\[.+\]\(.+\))/, lang: 'markdown' },
  ];

  for (const item of codeIndicators) {
    if (item.regex.test(trimmed)) {
      return { category: 'code', language: item.lang };
    }
  }

  return { category: 'plain' };
}
