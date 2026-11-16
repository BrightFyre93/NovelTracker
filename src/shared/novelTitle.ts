export function normalizeNovelTitleForMatching(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

export function normalizeNovelTitleForGrouping(value: string): string {
  return value.trim().toLocaleLowerCase()
}
