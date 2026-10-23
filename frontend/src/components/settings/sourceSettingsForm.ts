import {
  formatHours,
  type GlobalSettings,
  type SessionSettings,
  type SourceInfo,
} from '../../lib/adminApi';

/**
 * One form for global and session settings:
 * - global:  which sources sessions may use, plus the default weight/parameters and expiry
 * - session: which of those sources this session uses, with optional weight/parameter overrides
 * - create:  the short version of `session` used in the "New session" dialog (no overrides)
 */
export type FormMode = 'global' | 'session' | 'create';

export interface GlobalFormValue {
  sessionTtlHours: number;
  sources: Record<string, { enabled: boolean; weight: number; params: Record<string, string> }>;
}

export interface SessionFormValue {
  name: string | null;
  ttlHours: number | null;
  sources: Record<string, { enabled: boolean; weight: number | null; params: Record<string, string> }>;
}

export interface SourceSettingsForm<T> {
  /** Validated value, or an error message */
  read(): T | string;
  /** Serialized state of every control, to detect unsaved changes */
  state(): string;
}

type SessionInfo = { name: string | null; settings: SessionSettings };
type ParamInput = HTMLInputElement | HTMLSelectElement;
type ParamInfo = SourceInfo['params'][number];

interface Ctx {
  mode: FormMode;
  isGlobal: boolean;
  global: GlobalSettings;
  session: SessionInfo | null;
}

interface SourceControls {
  source: SourceInfo;
  enabled: HTMLInputElement;
  weight: HTMLInputElement | null;
  share: HTMLElement;
  params: Map<string, ParamInput>;
}

/** Parts of the form that are built separately, then combined by `render` */
interface Part {
  nodes: Node[];
  /** Values of all controls, for change detection */
  values(): unknown[];
}

const MAX_HOURS = 8760;
const WEIGHT_HELP = 'Relative chance of being picked. 0 = never.';

let formCounter = 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

const hoursInput = (props: Parameters<typeof el<'input'>>[1] = {}) =>
  el('input', { type: 'number', min: '1', max: String(MAX_HOURS), step: '1', ...props });

function parseHours(raw: string): number | string {
  const hours = Number(raw);
  return Number.isInteger(hours) && hours >= 1 && hours <= MAX_HOURS
    ? hours
    : `Expiry must be between 1 and ${MAX_HOURS} hours.`;
}

export function renderGlobalSettingsForm(
  container: HTMLElement,
  settings: GlobalSettings,
): SourceSettingsForm<GlobalFormValue> {
  return render(container, 'global', settings, null) as SourceSettingsForm<GlobalFormValue>;
}

export function renderSessionSettingsForm(
  container: HTMLElement,
  global: GlobalSettings,
  session: SessionInfo | null,
  mode: 'session' | 'create' = 'session',
): SourceSettingsForm<SessionFormValue> {
  return render(container, mode, global, session) as SourceSettingsForm<SessionFormValue>;
}

// --- General (name and expiry) ---

function globalGeneral(ctx: Ctx) {
  const ttl = hoursInput({ required: true, value: String(ctx.global.sessionTtlHours) });
  const part: Part = {
    nodes: [
      el('label', {}, [
        'Expire sessions after this many hours of inactivity',
        ttl,
        el('small', {}, ['The default for every session. A session can set its own expiry, or never expire.']),
      ]),
    ],
    values: () => [ttl.value],
  };
  return { part, readTtl: () => parseHours(ttl.value) };
}

function sessionGeneral(ctx: Ctx) {
  const id = `ssf${++formCounter}-ttl`;
  const ttlHours = ctx.session?.settings.ttlHours ?? null;
  const name = el('input', { type: 'text', maxLength: 100, placeholder: 'e.g. Living room', value: ctx.session?.name ?? '' });
  const select = el('select', { id }, [
    el('option', { value: 'default' }, [`Global default (${formatHours(ctx.global.sessionTtlHours)})`]),
    el('option', { value: 'custom' }, ['Custom']),
    el('option', { value: 'never' }, ['Never expire']),
  ]);
  const hours = hoursInput({ placeholder: 'Hours', value: ttlHours ? String(ttlHours) : '' });
  select.value = ttlHours === null ? 'default' : ttlHours === 0 ? 'never' : 'custom';

  const custom = el('label', {}, ['Hours of inactivity', hours]);
  const sync = () => (custom.hidden = select.value !== 'custom');
  select.addEventListener('change', sync);
  sync();

  const part: Part = {
    nodes: [
      el('div', { className: 'grid' }, [
        el('label', {}, ['Name', name]),
        el('label', { htmlFor: id }, ['Expiry when inactive', select]),
      ]),
      custom,
    ],
    values: () => [name.value, select.value, hours.value],
  };
  const readTtl = (): number | null | string =>
    select.value === 'never' ? 0 : select.value === 'custom' ? parseHours(hours.value) : null;
  return { part, readTtl, readName: () => name.value.trim() || null };
}

// --- Source parameters ---

/** A list of checkboxes that writes a comma separated value to a hidden field */
function multiParam(param: ParamInfo, value: string, fallback: string, help: string) {
  const options = param.options!;
  const field = el('input', { type: 'hidden', value });
  // Without a value of its own the fallback is checked, so the boxes show what is in effect.
  // The hidden field stays empty until a box changes, so it keeps following the fallback.
  const chosen = new Set((value || fallback).split(',').map((v) => v.trim()).filter(Boolean));
  const boxes = options.map((o) => el('input', { type: 'checkbox', value: o.value, checked: chosen.has(o.value) }));
  const choices = el('div', { className: 'ssf-multi' }, boxes.map((box, i) => el('label', {}, [box, options[i].label])));
  choices.addEventListener('change', () => {
    field.value = boxes.filter((b) => b.checked).map((b) => b.value).join(',');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const node = el('fieldset', {}, [
    el('legend', {}, [param.label]),
    choices,
    ...(help ? [el('small', {}, [help])] : []),
    field,
  ]);
  return { node, input: field };
}

function paramField(ctx: Ctx, param: ParamInfo, override: string | undefined) {
  const { isGlobal } = ctx;
  const globalValue = param.value || param.default;
  const value = isGlobal ? param.value : (override ?? '');
  const fallback = isGlobal ? param.default : globalValue;
  // Choices show their fallback themselves, so only text fields mention it
  const help = param.options
    ? (param.description ?? '')
    : `${param.description ? `${param.description}. ` : ''}${isGlobal ? 'Built-in default' : 'Global'}: ${fallback}`;

  if (param.options && param.multiple) return multiParam(param, value, fallback, help);

  const note = help ? [el('small', {}, [help])] : [];
  if (!param.options) {
    const input = el('input', { type: 'text', value, placeholder: fallback });
    return { node: el('label', {}, [param.label, input, ...note]), input };
  }

  const labelOf = (v: string) =>
    v
      .split(',')
      .map((part) => param.options!.find((o) => o.value === part.trim())?.label ?? part.trim())
      .join(', ');
  // The empty choice falls back, like an empty text field
  const input = el('select', {}, [
    el('option', { value: '' }, [`${isGlobal ? 'Default' : 'Global'} (${labelOf(fallback)})`]),
    ...param.options.map((o) => el('option', { value: o.value }, [o.label])),
  ]);
  input.value = value;
  return { node: el('label', {}, [param.label, input, ...note]), input };
}

// --- Source row ---

/** Only one source's parameters are open at a time, so the list stays short */
function paramsToggle(open: { current: { panel: HTMLElement; button: HTMLButtonElement } | null }) {
  return (panel: HTMLElement, button: HTMLButtonElement) => {
    const opening = panel.hidden;
    if (open.current) {
      open.current.panel.hidden = true;
      open.current.button.setAttribute('aria-expanded', 'false');
      open.current = null;
    }
    if (opening) {
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      open.current = { panel, button };
      panel.querySelector<HTMLElement>('input:not([type=hidden]), select')?.focus({ preventScroll: true });
    }
  };
}

function render(
  container: HTMLElement,
  mode: FormMode,
  global: GlobalSettings,
  session: SessionInfo | null,
): SourceSettingsForm<GlobalFormValue | SessionFormValue> {
  const isGlobal = mode === 'global';
  const ctx: Ctx = { mode, isGlobal, global, session };
  const sessionSources = session?.settings.sources ?? {};
  container.replaceChildren();
  container.className = `ssf ssf-mode-${mode}`;

  // --- General ---

  const globalPart = isGlobal ? globalGeneral(ctx) : null;
  const sessionPart = isGlobal ? null : sessionGeneral(ctx);
  const general = (globalPart ?? sessionPart!).part;
  container.append(el('section', { className: 'ssf-section' }, general.nodes));

  // --- Sources ---

  const help = isGlobal
    ? 'Choose which sources sessions can use. The weight and parameters here are the defaults; a session can override them.'
    : mode === 'create'
      ? 'Weights and parameters can be changed later in the session settings.'
      : 'A source is picked at random for every image, weighted by its weight. Leave a field empty to use the global setting.';
  const sourcesSection = el('section', { className: 'ssf-section' }, [
    el('h3', {}, ['Image sources']),
    el('p', { className: 'ssf-help' }, [help]),
  ]);
  const list = el('div', { className: 'ssf-sources', role: 'list' });
  const unconfiguredList = el('div', { className: 'ssf-sources', role: 'list' });
  const controls: SourceControls[] = [];
  const unavailable: SourceInfo[] = [];
  const rows: { row: HTMLElement; panel: HTMLElement | null; label: string }[] = [];
  const toggleParams = paramsToggle({ current: null });
  let unconfiguredCount = 0;

  // Column headings (hidden on narrow screens, where each row wraps)
  if (mode !== 'create') {
    const head = el('div', { className: 'ssf-row ssf-row-head' }, [
      el('span', {}, ['Source']),
      el('span', { className: 'ssf-col-share' }, ['Share']),
      el('span', { className: 'ssf-col-weight', title: WEIGHT_HELP }, [isGlobal ? 'Default weight' : 'Weight']),
      el('span'),
    ]);
    head.setAttribute('aria-hidden', 'true');
    list.append(head);
  }

  for (const source of global.sources) {
    if (!isGlobal && !(source.available && source.enabled)) {
      unavailable.push(source);
      continue;
    }
    const override = sessionSources[source.name];
    const enabled = el('input', {
      type: 'checkbox',
      checked: isGlobal ? source.enabled : (override?.enabled ?? true),
      disabled: isGlobal && !source.available,
    });
    enabled.setAttribute('role', 'switch');
    enabled.setAttribute('aria-label', `Use ${source.label}`);
    const share = el('span', { className: 'ssf-share ssf-col-share' });
    const note = el('small', { className: 'ssf-note' }, [
      isGlobal && !source.available ? `Needs ${source.missingEnv.join(', ')}` : '',
    ]);
    const row = el('div', { className: 'ssf-row' }, [
      el('label', { className: 'ssf-name' }, [enabled, el('span', {}, [el('strong', {}, [source.label]), note])]),
      share,
    ]);
    row.setAttribute('role', 'listitem');

    let weight: HTMLInputElement | null = null;
    let panel: HTMLElement | null = null;
    const params = new Map<string, ParamInput>();

    if (mode !== 'create') {
      weight = el('input', {
        type: 'number',
        min: '0',
        max: '100',
        step: '0.5',
        className: 'ssf-col-weight',
        value: isGlobal ? String(source.weight) : override?.weight != null ? String(override.weight) : '',
        placeholder: isGlobal ? '1' : String(source.weight),
        title: isGlobal ? WEIGHT_HELP : `Empty = global weight (${source.weight})`,
      });
      weight.setAttribute('aria-label', `${source.label} weight`);
      row.append(weight);

      if (source.params.length) {
        const button = el('button', { type: 'button', className: 'ssf-params-btn secondary outline' }, ['Parameters']);
        button.setAttribute('aria-expanded', 'false');
        const fields = el('div', { className: 'ssf-param-fields' });
        for (const param of source.params) {
          const field = paramField(ctx, param, override?.params?.[param.key]);
          fields.append(field.node);
          params.set(param.key, field.input);
        }
        const thisPanel = el('div', { className: 'ssf-panel', hidden: true }, [fields]);
        panel = thisPanel;
        button.addEventListener('click', () => toggleParams(thisPanel, button));

        const updateButton = () => {
          const changed = [...params.values()].filter((input) => input.value.trim()).length;
          const what = isGlobal ? 'changed from the built-in default' : 'overridden for this session';
          button.textContent = changed ? `Parameters (${changed})` : 'Parameters';
          button.classList.toggle('ssf-params-changed', changed > 0);
          button.title = changed ? `${changed} parameter${changed === 1 ? '' : 's'} ${what}` : '';
        };
        fields.addEventListener('input', updateButton);
        fields.addEventListener('change', updateButton);
        updateButton();
        row.append(button);
      } else {
        row.append(el('span'));
      }
    }

    const sync = () => row.classList.toggle('ssf-off', !enabled.checked);
    enabled.addEventListener('change', sync);
    sync();
    controls.push({ source, enabled, weight, share, params });

    const unconfigured = isGlobal && !source.available;
    if (unconfigured) unconfiguredCount++;
    const target = unconfigured ? unconfiguredList : list;
    target.append(row);
    if (panel) target.append(panel);
    rows.push({ row, panel, label: source.label.toLowerCase() });
  }

  // A filter once the list gets long
  if (rows.length > 8) {
    const filter = el('input', { type: 'search', placeholder: 'Filter sources…', className: 'ssf-filter' });
    filter.setAttribute('aria-label', 'Filter sources');
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const { row, panel, label } of rows) {
        row.hidden = Boolean(q) && !label.includes(q);
        if (panel && row.hidden) panel.hidden = true;
      }
    });
    sourcesSection.append(filter);
  }

  if (!isGlobal && controls.length === 0) {
    list.append(el('p', { className: 'ssf-help' }, ['No sources are enabled in the global settings.']));
  }
  sourcesSection.append(list);
  if (unconfiguredCount) {
    sourcesSection.append(
      el('details', { className: 'ssf-unconfigured' }, [
        el('summary', {}, [`Not configured (${unconfiguredCount})`]),
        el('p', { className: 'ssf-help' }, ['These sources need settings in the API environment before they can be switched on.']),
        unconfiguredList,
      ]),
    );
  }
  if (unavailable.length) {
    sourcesSection.append(
      el('p', { className: 'ssf-help' }, [
        `${unavailable.map((s) => s.label).join(', ')} ${unavailable.length === 1 ? 'is' : 'are'} not available, see `,
        el('a', { href: '/admin/settings' }, ['global settings']),
        '.',
      ]),
    );
  }
  container.append(sourcesSection);

  // --- Live share of images per source ---

  const effectiveWeight = (c: SourceControls) => {
    if (!c.enabled.checked) return 0;
    const raw = c.weight?.value.trim() ?? '';
    return raw === '' ? (isGlobal ? 1 : c.source.weight) : Number(raw) || 0;
  };
  const hasPickableSource = () => controls.some((c) => effectiveWeight(c) > 0);
  const updateShares = () => {
    const total = controls.reduce((sum, c) => sum + effectiveWeight(c), 0);
    for (const c of controls) {
      const w = effectiveWeight(c);
      const text = total > 0 && w > 0 ? `${Math.round((w / total) * 100)}%` : c.enabled.checked ? 'never' : '–';
      c.share.textContent = text;
      c.share.title = text.endsWith('%') ? 'Share of images from this source' : '';
    }
  };
  container.addEventListener('input', updateShares);
  container.addEventListener('change', updateShares);
  updateShares();

  // --- Reading ---

  const state = () =>
    JSON.stringify([
      general.values(),
      controls.map((c) => [c.enabled.checked, c.weight?.value, [...c.params.values()].map((p) => p.value)]),
    ]);

  const readParams = (c: SourceControls) =>
    Object.fromEntries([...c.params].map(([key, input]) => [key, input.value.trim()]).filter(([, v]) => v));

  const readWeight = (c: SourceControls): number | null | string => {
    const raw = c.weight?.value.trim() ?? '';
    if (raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : `${c.source.label}: weight must be between 0 and 100.`;
  };

  function read(): GlobalFormValue | SessionFormValue | string {
    const ttlHours = (globalPart ?? sessionPart!).readTtl();
    if (typeof ttlHours === 'string') return ttlHours;

    // A source with weight 0 is never picked, so it doesn't count
    if (controls.length && !hasPickableSource()) return 'Switch on at least one source with a weight above 0.';

    // Keep overrides of sources that are hidden because they're switched off globally
    const sources: SessionFormValue['sources'] = Object.fromEntries(
      unavailable.filter((s) => sessionSources[s.name]).map((s) => [s.name, sessionSources[s.name]]),
    );
    for (const c of controls) {
      const weight = readWeight(c);
      if (typeof weight === 'string') return weight;
      sources[c.source.name] = {
        enabled: c.enabled.checked,
        weight,
        params: mode === 'create' ? {} : readParams(c),
      };
    }

    if (isGlobal) {
      return {
        sessionTtlHours: ttlHours!,
        sources: Object.fromEntries(
          Object.entries(sources).map(([name, s]) => [name, { ...s, weight: s.weight ?? 1 }]),
        ),
      };
    }
    return { name: sessionPart!.readName(), ttlHours, sources };
  }

  return { read, state };
}
