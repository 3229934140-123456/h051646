import { EntityClass } from '../mapping';

export type EntityIdentity = string;

export class IdentityMap {
  private entities: Map<Function, Map<EntityIdentity, any>> = new Map();

  get<T>(entityClass: EntityClass<T>, id: EntityIdentity): T | undefined {
    const classMap = this.entities.get(entityClass);
    return classMap?.get(id) as T | undefined;
  }

  set<T>(entityClass: EntityClass<T>, id: EntityIdentity, entity: T): void {
    if (!this.entities.has(entityClass)) {
      this.entities.set(entityClass, new Map());
    }
    this.entities.get(entityClass)!.set(id, entity);
  }

  has(entityClass: EntityClass, id: EntityIdentity): boolean {
    return this.entities.get(entityClass)?.has(id) ?? false;
  }

  remove(entityClass: EntityClass, id: EntityIdentity): boolean {
    return this.entities.get(entityClass)?.delete(id) ?? false;
  }

  clear(): void {
    this.entities.clear();
  }

  clearEntity(entityClass: EntityClass): void {
    this.entities.delete(entityClass);
  }

  getAll<T>(entityClass: EntityClass<T>): T[] {
    const classMap = this.entities.get(entityClass);
    return classMap ? Array.from(classMap.values()) as T[] : [];
  }

  size(): number {
    let count = 0;
    for (const classMap of this.entities.values()) {
      count += classMap.size;
    }
    return count;
  }

  buildIdentity(primaryKeys: string[], values: Record<string, any>): EntityIdentity {
    if (primaryKeys.length === 0) {
      return JSON.stringify(values);
    }
    if (primaryKeys.length === 1) {
      return String(values[primaryKeys[0]]);
    }
    return primaryKeys.map((pk) => String(values[pk])).join('::');
  }
}
