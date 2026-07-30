import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@shared/errors';
import type { Project } from '@shared/models';
import type { SettingsIssue } from '@shared/settings';
import type { AppDatabase } from '../db';
import {
  ProjectSettingsRepo,
  type ProjectSettingsObject,
} from '../db/repos/projectSettings';
import { SettingsService } from '.';
import {
  PROJECT_SETTINGS_DIR,
  PROJECT_SHARED_FILE,
  readLegacyProjectSettings,
  withSettingValue,
} from './write';

export interface StoredProjectSettings {
  value: ProjectSettingsObject;
  issues: SettingsIssue[];
}

export async function loadStoredProjectSettings(
  db: AppDatabase,
  project: Project,
): Promise<StoredProjectSettings> {
  const repo = new ProjectSettingsRepo(db);
  const stored = await repo.get(project.id);
  if (stored !== null) return { value: stored, issues: [] };

  const file = join(
    project.repoPath,
    PROJECT_SETTINGS_DIR,
    PROJECT_SHARED_FILE,
  );
  let legacy: ProjectSettingsObject | undefined;
  try {
    legacy = readLegacyProjectSettings(project.repoPath);
    const value = legacy ?? {};
    const validator = new SettingsService();
    validator.load({
      projectDir: project.repoPath,
      projectSettings: value,
    });
    const concurrentlyStored = await repo.get(project.id);
    if (concurrentlyStored !== null) {
      if (existsSync(file)) unlinkSync(file);
      return { value: concurrentlyStored, issues: [] };
    }
    await repo.save(project.id, value);
    if (legacy !== undefined && existsSync(file)) unlinkSync(file);
    return { value, issues: [] };
  } catch (error) {
    return {
      value: {},
      issues: [
        {
          file,
          message: `Could not migrate project settings to the database: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }
}

export async function saveStoredProjectSetting(
  db: AppDatabase,
  project: Project,
  keyPath: string,
  value: unknown,
): Promise<ProjectSettingsObject> {
  const loaded = await loadStoredProjectSettings(db, project);
  if (loaded.issues.length > 0) {
    throw new AppError('settings', loaded.issues[0].message);
  }
  const next = withSettingValue(loaded.value, keyPath, value);
  const validator = new SettingsService();
  const result = validator.loadResult({
    projectDir: project.repoPath,
    projectSettings: next,
  });
  if (result.issues.length > 0) {
    throw new AppError(
      'settings',
      `Setting ${keyPath} to that value is invalid: ${result.issues[0].message}`,
      { keyPath, layer: 'project-shared' },
    );
  }
  await new ProjectSettingsRepo(db).save(project.id, next);
  return next;
}
