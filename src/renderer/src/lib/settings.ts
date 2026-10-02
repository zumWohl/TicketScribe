// localStorage-backed settings + Summary Templates CRUD. 1:1 port of app.js's
// ls/set helpers and the "Summary templates" section -- key names, defaults
// and ls()'s `getItem(k) || d` fallback semantics (NOT `??`) unchanged.
export const DEFAULT_THRESHOLD = 5;

export function ls(k: string, d: string): string {
  return localStorage.getItem(k) || d;
}
export function set(k: string, v: string): void {
  localStorage.setItem(k, v);
}

export interface SummaryTemplate {
  id: string;
  title: string;
  content: string;
}

export function loadTemplates(): SummaryTemplate[] {
  try {
    const v = JSON.parse(ls('summaryTemplates', '[]'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function saveTemplates(list: SummaryTemplate[]): void {
  set('summaryTemplates', JSON.stringify(list));
}
export function getActiveTemplateId(): string {
  return localStorage.getItem('activeTemplateId') || '';
}
export function setActiveTemplateId(id: string): void {
  set('activeTemplateId', id || '');
}

// providers.js's activeTemplateContent(), reusing the same storage helpers
// instead of a second independent localStorage read.
export function activeTemplateContentForGenerate(): string {
  const id = getActiveTemplateId();
  if (!id) return '';
  const t = loadTemplates().find(x => x.id === id);
  return t && t.content ? String(t.content).trim() : '';
}
