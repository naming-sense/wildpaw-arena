export class ServiceLocator {
  private readonly services = new Map<string, unknown>();

  set<T>(key: string, value: T): void {
    this.services.set(key, value);
  }

  get<T>(key: string): T {
    const value = this.services.get(key);
    if (!value) {
      throw new Error(`Service not found: ${key}`);
    }
    return value as T;
  }
}
