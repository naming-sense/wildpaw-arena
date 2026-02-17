export class ObjectPool<T> {
  private readonly pool: T[] = [];

  constructor(private readonly create: () => T) {}

  acquire(): T {
    return this.pool.pop() ?? this.create();
  }

  release(value: T): void {
    this.pool.push(value);
  }
}
