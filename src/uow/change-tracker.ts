import { EntityClass } from '../mapping';
import { metadataStore } from '../mapping';
import { EntityState, EntityEntry } from './types';

export class ChangeTracker {
  private entries: Map<EntityClass, Map<string, EntityEntry>> = new Map();
  private entityToKey: Map<any, { entityClass: EntityClass; key: string }> = new Map();

  registerNew<T>(entity: T, entityClass: EntityClass<T>): EntityEntry<T> {
    this.ensureClassMap(entityClass);
    const key = this.generateTempKey(entity, entityClass);
    const entry: EntityEntry<T> = {
      entity,
      entityClass,
      state: 'new',
      originalValues: null,
      currentValues: this.extractValues(entity, entityClass),
    };
    this.entries.get(entityClass)!.set(key, entry as EntityEntry);
    this.entityToKey.set(entity, { entityClass, key });
    return entry;
  }

  registerManaged<T>(
    entity: T,
    entityClass: EntityClass<T>,
    originalValues?: Record<string, any>
  ): EntityEntry<T> {
    this.ensureClassMap(entityClass);
    const key = this.generateKey(entity, entityClass);
    if (!key) {
      throw new Error(`Cannot register managed entity without primary key: ${entityClass.name}`);
    }
    const values = this.extractValues(entity, entityClass);
    const entry: EntityEntry<T> = {
      entity,
      entityClass,
      state: 'managed',
      originalValues: originalValues || { ...values },
      currentValues: values,
    };
    this.entries.get(entityClass)!.set(key, entry as EntityEntry);
    this.entityToKey.set(entity, { entityClass, key });
    return entry;
  }

  registerRemoved<T>(entity: T, entityClass: EntityClass<T>): EntityEntry<T> {
    const existing = this.getEntry(entity);
    if (existing) {
      existing.state = 'removed';
      return existing as EntityEntry<T>;
    }
    this.ensureClassMap(entityClass);
    const key = this.generateKey(entity, entityClass) || this.generateTempKey(entity, entityClass);
    const entry: EntityEntry<T> = {
      entity,
      entityClass,
      state: 'removed',
      originalValues: this.extractValues(entity, entityClass),
      currentValues: this.extractValues(entity, entityClass),
    };
    this.entries.get(entityClass)!.set(key, entry as EntityEntry);
    this.entityToKey.set(entity, { entityClass, key });
    return entry;
  }

  detectChanges(): void {
    for (const classMap of this.entries.values()) {
      for (const entry of classMap.values()) {
        if (entry.state === 'managed' || entry.state === 'modified') {
          const currentValues = this.extractValues(entry.entity, entry.entityClass);
          entry.currentValues = currentValues;
          if (this.hasChanges(entry)) {
            entry.state = 'modified';
          }
        }
      }
    }
  }

  getEntry<T>(entity: T): EntityEntry<T> | undefined {
    const info = this.entityToKey.get(entity);
    if (!info) return undefined;
    return this.entries.get(info.entityClass)?.get(info.key) as EntityEntry<T> | undefined;
  }

  getEntityState<T>(entity: T): EntityState {
    const entry = this.getEntry(entity);
    return entry?.state || 'detached';
  }

  setEntityState<T>(entity: T, state: EntityState): void {
    const entry = this.getEntry(entity);
    if (entry) {
      entry.state = state;
    }
  }

  getEntriesByState(state: EntityState): EntityEntry[] {
    const result: EntityEntry[] = [];
    for (const classMap of this.entries.values()) {
      for (const entry of classMap.values()) {
        if (entry.state === state) {
          result.push(entry);
        }
      }
    }
    return result;
  }

  getAllEntries(): EntityEntry[] {
    const result: EntityEntry[] = [];
    for (const classMap of this.entries.values()) {
      for (const entry of classMap.values()) {
        result.push(entry);
      }
    }
    return result;
  }

  getAllByClass<T>(entityClass: EntityClass<T>): EntityEntry<T>[] {
    const classMap = this.entries.get(entityClass);
    if (!classMap) return [];
    return Array.from(classMap.values()) as EntityEntry<T>[];
  }

  acceptChanges(): void {
    for (const classMap of this.entries.values()) {
      for (const entry of Array.from(classMap.values())) {
        if (entry.state === 'removed') {
          classMap.delete(this.entityToKey.get(entry.entity)!.key);
          this.entityToKey.delete(entry.entity);
        } else if (entry.state === 'new' || entry.state === 'modified') {
          entry.state = 'managed';
          entry.originalValues = { ...entry.currentValues };
        }
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.entityToKey.clear();
  }

  removeEntry(entity: any): void {
    const info = this.entityToKey.get(entity);
    if (info) {
      this.entries.get(info.entityClass)?.delete(info.key);
      this.entityToKey.delete(entity);
    }
  }

  hasChanges(entry: EntityEntry): boolean {
    if (entry.originalValues === null) return true;
    const currentValues = this.extractValues(entry.entity, entry.entityClass);
    for (const key of Object.keys(currentValues)) {
      const orig = entry.originalValues[key];
      const curr = currentValues[key];
      if (!this.valuesEqual(orig, curr)) {
        return true;
      }
    }
    return false;
  }

  getChangedColumns(entry: EntityEntry | undefined): string[] {
    if (!entry) return [];
    const currentValues = this.extractValues(entry.entity, entry.entityClass);
    if (!entry.originalValues) {
      return Object.keys(currentValues);
    }
    const changes: string[] = [];
    for (const key of Object.keys(currentValues)) {
      if (!this.valuesEqual(entry.originalValues[key], currentValues[key])) {
        changes.push(key);
      }
    }
    return changes;
  }

  private extractValues<T>(entity: T, entityClass: EntityClass<T>): Record<string, any> {
    const meta = metadataStore.getEntityMetadata(entityClass);
    const values: Record<string, any> = {};
    const obj = entity as Record<string, any>;
    if (meta) {
      for (const propKey of meta.columns.keys()) {
        values[propKey] = obj[propKey];
      }
    } else {
      Object.assign(values, obj);
    }
    return values;
  }

  private generateKey<T>(entity: T, entityClass: EntityClass<T>): string | null {
    const meta = metadataStore.getEntityMetadata(entityClass);
    if (!meta || meta.primaryKeys.length === 0) return null;
    const obj = entity as Record<string, any>;
    const pkValues = meta.primaryKeys.map((pk) => obj[pk]);
    if (pkValues.some((v) => v === undefined || v === null)) return null;
    if (pkValues.length === 1) return String(pkValues[0]);
    return pkValues.map((v) => String(v)).join('::');
  }

  private generateTempKey<T>(entity: T, entityClass: EntityClass<T>): string {
    return `temp_${entityClass.name}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private ensureClassMap(entityClass: EntityClass): void {
    if (!this.entries.has(entityClass)) {
      this.entries.set(entityClass, new Map());
    }
  }

  private valuesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return String(a) === String(b);
  }
}
