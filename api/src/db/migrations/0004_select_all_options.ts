import type { DatabaseSync } from 'node:sqlite';

/**
 * Multiple choice parameters no longer have a value meaning "everything"; every option is checked
 * instead. The option lists as they were when this migration was written.
 */
const REPLACEMENTS: { generator: string; param: string; everything: string; options: string[] }[] = [
  {
    generator: 'MetGenerator',
    param: 'objectTypes',
    everything: '*',
    options: ['painting', 'photograph', 'drawing', 'print', 'scroll', 'thangka', 'sculpture', 'textile', 'ceramic', 'glass', 'metal', 'furniture'],
  },
  {
    generator: 'EuropeanaGenerator',
    param: 'museums',
    everything: 'any',
    options: [
      'Rijksmuseum',
      'Mauritshuis',
      'National Gallery of Denmark',
      'Brukenthal National Museum',
      'National Museum of Art of Romania',
      'Slovak national gallery',
      'ASTRA National Museum Complex',
      'Metropolitan Organisation of Museums of Visual Arts of Thessaloniki – MOMus',
      'Athens School of Fine Arts',
      'B&M Theocharakis Foundation for the Fine Arts and Music',
      'State Association of Fine Arts Saxony eV',
      'Art Collection of the University Göttingen',
      'Constanța Art Museum',
      'Järvenpää Art Museum',
    ],
  },
];

type Sources = Record<string, { params?: Record<string, string> } | null> | null | undefined;

/** Replaces the "everything" values in place; returns whether anything changed */
function replace(sources: Sources): boolean {
  let changed = false;
  for (const { generator, param, everything, options } of REPLACEMENTS) {
    const params = sources?.[generator]?.params;
    const values = params?.[param]?.split(',').map((v) => v.trim().toLowerCase());
    if (params && values?.includes(everything)) {
      params[param] = options.join(',');
      changed = true;
    }
  }
  return changed;
}

export function up(db: DatabaseSync) {
  const global = db.prepare(`SELECT value FROM settings WHERE key = 'sources'`).get() as
    | { value: string }
    | undefined;
  if (global) {
    const sources = JSON.parse(global.value) as Sources;
    if (replace(sources)) {
      db.prepare(`UPDATE settings SET value = ? WHERE key = 'sources'`).run(JSON.stringify(sources));
    }
  }

  const sessions = db.prepare(`SELECT id, settings FROM sessions WHERE settings IS NOT NULL`).all() as {
    id: string;
    settings: string;
  }[];
  for (const { id, settings } of sessions) {
    const parsed = JSON.parse(settings) as { sources?: Sources };
    if (replace(parsed.sources)) {
      db.prepare(`UPDATE sessions SET settings = ? WHERE id = ?`).run(JSON.stringify(parsed), id);
    }
  }
}

export function down() {
  // Every option checked works the same as before, there is nothing to undo
}
