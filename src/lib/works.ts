import { getCollection, type CollectionEntry } from 'astro:content';

export type Work = CollectionEntry<'works'>;
export type WorkKind = Work['data']['kind'];

/** All works visible in this build: drafts only in `astro dev`. */
export async function getWorks(): Promise<Work[]> {
  const works = await getCollection('works', ({ data }) => !import.meta.env.PROD || !data.draft);
  // Newest first; the id tie-break keeps same-date entries in a stable order.
  return works.sort((a, b) => b.data.date.value.valueOf() - a.data.date.value.valueOf() || a.id.localeCompare(b.id));
}

export function ofKind(works: Work[], ...kinds: WorkKind[]): Work[] {
  return works.filter((work) => kinds.includes(work.data.kind));
}

export function workUrl(work: Work): string {
  return work.data.kind === 'project' ? `/projects/${work.id}/` : `/research/${work.id}/`;
}

export const STATUS_LABEL: Record<Work['data']['status'], string> = {
  'under-review': 'under review',
  accepted: 'accepted',
  published: 'published',
};

export const KIND_LABEL: Record<WorkKind, string> = {
  paper: 'Paper',
  workshop: 'Workshop paper',
  thesis: 'Thesis',
  project: 'Project',
  talk: 'Talk',
};

export const LINK_LABELS = [
  ['pdf', 'PDF'],
  ['code', 'Code'],
  ['video', 'Video'],
  ['slides', 'Slides'],
  ['site', 'Website'],
] as const;

export type WorkDate = Work['data']['date'];

/** Human-readable date at the entry's own precision: "2024", "May 2024" or "1 May 2024" (UTC). */
export function formatDate({ value, precision }: WorkDate): string {
  return value.toLocaleDateString('en-GB', {
    year: 'numeric',
    ...(precision !== 'year' ? { month: 'short' } : {}),
    ...(precision === 'day' ? { day: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

/** Machine-readable `<time datetime>` value at the same precision: "2024", "2024-05" or "2024-05-01". */
export function isoDate({ value, precision }: WorkDate): string {
  return value.toISOString().slice(0, { year: 4, month: 7, day: 10 }[precision]);
}
