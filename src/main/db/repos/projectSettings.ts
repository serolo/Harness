import type { AppDatabase } from '../index';

export type ProjectSettingsObject = Record<string, unknown>;

export class ProjectSettingsRepo {
  constructor(private readonly db: AppDatabase) {}

  async get(projectId: string): Promise<ProjectSettingsObject | null> {
    const row = await this.db
      .selectFrom('project_settings')
      .select('settings_json')
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const value: unknown = JSON.parse(row.settings_json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Stored project settings must be an object');
    }
    return value as ProjectSettingsObject;
  }

  async save(
    projectId: string,
    settings: ProjectSettingsObject,
  ): Promise<void> {
    await this.db
      .insertInto('project_settings')
      .values({
        project_id: projectId,
        settings_json: JSON.stringify(settings),
        updated_at: Date.now(),
      })
      .onConflict((conflict) =>
        conflict.column('project_id').doUpdateSet({
          settings_json: JSON.stringify(settings),
          updated_at: Date.now(),
        }),
      )
      .execute();
  }
}
