import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codeLabel,
  intlLocale,
  normalizeLanguage,
  number,
  setLanguage,
  t,
  translate,
} from './i18n.svelte';
import hu from './hu.json';
import { defaultSettings, createEntity, defaultData, textDoc, plainText } from '../domain/defaults';
import { BUILT_IN_TEMPLATES, getBuiltInTemplates } from '../domain/templates';
import { Workspace } from '../services/workspace.svelte';
import type { WorkspaceRepository } from '../services/repository';
import type { Project } from '../domain/types';
import { assembleReportSnapshot, validateReportSnapshot } from '../services/reports/snapshot';
import { buildReportModel, reportText } from '../services/reports/model';
import { htmlBytes } from '../services/reports/text-renderers';

afterEach(() => setLanguage('hu'));
describe('Hungarian and English localization', () => {
  it('defaults to Hungarian, safely migrates missing settings and formats numbers explicitly', () => {
    expect(defaultSettings.language).toBe('hu');
    expect(normalizeLanguage(undefined)).toBe('hu');
    expect(normalizeLanguage('de')).toBe('hu');
    expect(intlLocale('en')).toBe('en-GB');
    expect(number(12.5, undefined, 'hu')).toBe('12,5');
    expect(number(12.5, undefined, 'en')).toBe('12.5');
  });
  it('changes presentation without translating interpolation values or stable codes', () => {
    setLanguage('hu');
    expect(t('Settings')).toBe('Beállítások');
    expect(codeLabel('ready_for_retest')).toBe('Újratesztelésre kész');
    expect(t('Dataset: {name}', { name: 'Settings {step} <img>' })).toBe(
      'Adatkészlet: Settings {step} <img>',
    );
    setLanguage('en');
    expect(t('Settings')).toBe('Settings');
    expect(codeLabel('ready_for_retest')).toBe('Ready for retest');
    for (const [source, target] of Object.entries(hu)) {
      expect(target.trim(), source).not.toBe('');
      expect(target.match(/\{\w+\}/g)?.sort() ?? [], source).toEqual(
        source.match(/\{\w+\}/g)?.sort() ?? [],
      );
    }
  });
  it('persists language changes while preserving record bodies and revisions', async () => {
    let saved = structuredClone(defaultSettings);
    const repo = {
      mode: 'desktop',
      saveSettings: vi.fn(async (value) => {
        saved = structuredClone(value);
      }),
      getSettings: vi.fn(async () => saved),
      listProjects: vi.fn(async () => [{ id: 'project', archived: false }]),
      listRecords: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    } as unknown as WorkspaceRepository;
    const workspace = new Workspace(repo);
    const record = createEntity(
      'project',
      'document',
      'Settings',
      defaultData('document'),
      textDoc('English notes. Magyar ő és ű.'),
    );
    workspace.records = [record];
    const original = JSON.stringify(workspace.records);
    await workspace.setSettings({ language: 'en' });
    await workspace.setSettings({ language: 'hu' });
    expect(JSON.stringify(workspace.records)).toBe(original);
    expect(saved.language).toBe('hu');
    await workspace.setSettings({ language: 'en' });
    const reopened = new Workspace(repo);
    await reopened.initialize();
    expect(reopened.settings.language).toBe('en');
    expect(t('Settings')).toBe('Settings');
    workspace.dispose();
    reopened.dispose();
  });
  it('localizes all built-in presentation fields without changing IDs or domain enums', () => {
    const english = getBuiltInTemplates('project', undefined, 'en'),
      hungarian = getBuiltInTemplates('project', undefined, 'hu');
    expect(english).toHaveLength(17);
    const check = (source: string, target: string) => {
      expect(Object.hasOwn(hu, source), source).toBe(true);
      expect(target, source).toBe(translate(source, 'hu'));
    };
    english.forEach((template, i) => {
      const local = hungarian[i];
      expect(local.id).toBe(template.id);
      expect(local.data.targetKind).toBe(template.data.targetKind);
      check(template.title, local.title);
      check(template.data.description, local.data.description);
      template.data.fields.forEach((field, j) => {
        check(field.label, local.data.fields[j].label);
        expect(local.data.fields[j].id).toBe(field.id);
        if (field.options?.some((option) => /^[a-z]+$/.test(option)))
          expect(local.data.fields[j].options).toEqual(field.options);
      });
      template.data.sections.forEach((section, j) => {
        check(section.title, local.data.sections[j].title);
        check(section.guidance, local.data.sections[j].guidance);
      });
      for (const key of ['status', 'severity', 'priority', 'state', 'category'])
        expect(local.data.defaults[key]).toEqual(template.data.defaults[key]);
    });
    hungarian[0].title = 'User edit';
    expect(BUILT_IN_TEMPLATES[0].title).toBe('Product walkthrough');
    expect(getBuiltInTemplates('project', undefined, 'hu')[0].title).toBe(
      'Termékfolyamat bemutatása',
    );
  });
  it('freezes report language and preserves user text, with English fallback for old packages', async () => {
    const at = '2026-09-09T12:00:00.000Z';
    const project: Project = {
      id: 'p',
      name: 'Settings',
      description: '',
      prefix: 'TF',
      color: '#783D49',
      createdAt: at,
      updatedAt: at,
      revision: 1,
      archived: false,
    };
    const finding = createEntity(
      'p',
      'finding',
      'Original English title',
      {
        ...defaultData('finding'),
        code: 'TF-001',
        expected: 'Settings',
        actual: 'Árvíztűrő tükörfúrógép',
      },
      textDoc('Keep this prose unchanged.'),
    );
    const snapshot = await assembleReportSnapshot({
      project,
      records: [finding],
      options: {
        language: 'hu',
        format: 'html',
        title: 'User report',
        author: '',
        pageSize: 'A4',
        includeEvidence: false,
        includePrivate: false,
        includeHistory: false,
        scope: 'project',
        entityIds: [],
      },
      generatedAt: at,
      readAsset: async () => {
        throw new Error('Unexpected asset read');
      },
    });
    await validateReportSnapshot(snapshot);
    setLanguage('en');
    const model = buildReportModel(snapshot),
      text = reportText(model);
    expect(text).toContain('Elvárt');
    expect(text).toContain('Settings');
    expect(text).toContain('Árvíztűrő tükörfúrógép');
    expect(text).toContain('Keep this prose unchanged.');
    expect(plainText(snapshot.records[0].body)).toBe('Keep this prose unchanged.');
    const html = new TextDecoder().decode(htmlBytes(snapshot));
    expect(html).toContain('lang="hu"');
    const old = structuredClone(snapshot);
    delete old.options.language;
    await validateReportSnapshot(old);
    expect(reportText(buildReportModel(old))).toContain('Expected');
    await expect(
      validateReportSnapshot({ ...snapshot, options: { ...snapshot.options, language: 'de' } }),
    ).rejects.toThrow();
  });
});
